/**
 * Central model configuration for the POTIFY Shortcut Studio API server.
 *
 * Supports two providers (auto-selected at startup):
 *  1. OpenRouter  — preferred for production (large capable models)
 *  2. Replit AI Integrations proxy (OpenAI-compatible) — fallback / development
 *
 * Environment variables:
 *  OPENROUTER_API_KEY           Required for OpenRouter mode.
 *  OPENROUTER_BASE_URL          Default: https://openrouter.ai/api/v1
 *  OPENROUTER_REASONING_MODEL   Override the reasoning model (optional).
 *  AI_INTEGRATIONS_OPENAI_API_KEY   Replit proxy key (fallback when no OpenRouter key).
 *  AI_INTEGRATIONS_OPENAI_BASE_URL  Replit proxy base URL (fallback).
 *
 * No code in this file makes network calls. It only constructs configuration
 * and a ready-to-use OpenAI-SDK client. All callers receive an identical
 * OpenAI client interface regardless of provider.
 */

import OpenAI from "openai";
import { assertBudget, recordUsage } from "../learning/cost";

// ── Provider detection ──────────────────────────────────────────────────────

const isOpenRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);

// ── Model configuration ─────────────────────────────────────────────────────

export const MODEL_CONFIG = {
  /**
   * Primary model for generation, explanation, repair, and suggestion calls.
   *
   * OpenRouter:  deepseek/deepseek-chat
   *   DeepSeek-V3 685 B MoE. MIT-weight-licensed, strong structured-JSON
   *   output, 64 K context, 8 K typical output. Confirmed suitable for the
   *   six-stage IR pipeline in Task #15.
   *
   * Fallback:  gpt-5.6-terra
   *   Replit AI Integrations proxy. Used in development when no OpenRouter
   *   key is configured. Swap to meta-llama/llama-3.3-70b-instruct on
   *   OpenRouter as an alternative Apache-2 licensed fallback.
   */
  model: isOpenRouterConfigured ? "deepseek/deepseek-chat" : "gpt-5.6-terra",

  /**
   * Stronger model used only for the intent-extraction step (Task #15).
   * Defaults to the same model; override via OPENROUTER_REASONING_MODEL
   * if a separate reasoning-optimised model (e.g. deepseek/deepseek-r1) is
   * preferred for that step.
   */
  reasoningModel: isOpenRouterConfigured
    ? (process.env.OPENROUTER_REASONING_MODEL ?? "deepseek/deepseek-chat")
    : "gpt-5.6-terra",

  /** Max output tokens for generation / repair / explain calls. */
  maxCompletionTokens: 16_384,

  /** Reduced budget for fast single-step calls (suggest, semantic-validate). */
  maxCompletionTokensFast: 4_096,

  /**
   * Low temperature keeps outputs deterministic and schema-conformant.
   *
   * Not every model accepts it — see `temperatureParams`, which is what call
   * sites should use rather than passing this value directly.
   */
  temperature: 0.1,

  /** Base URL of the active LLM provider. */
  baseUrl: isOpenRouterConfigured
    ? (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1")
    : (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1"),

  /** Active provider name — used in logs and health checks. */
  provider: isOpenRouterConfigured ? "openrouter" : "replit-proxy",
} as const;

// ── Temperature support ─────────────────────────────────────────────────────

/**
 * Whether a model accepts an explicit `temperature`.
 *
 * The gpt-5 / o-series reasoning models reject any value other than their
 * default and return `400 unsupported_value`, which fails the entire request.
 * Because the pipeline sends a temperature on every stage, one unsupported
 * model silently turns every generate into a 500.
 */
export function supportsTemperature(model: string): boolean {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return !/^(?:gpt-5|o1|o3|o4)/i.test(bare);
}

/**
 * Spread into a chat-completions request to set the temperature only when the
 * target model supports it:
 *
 *   ...temperatureParams(MODEL)
 *   ...temperatureParams(MODEL, 0)
 */
export function temperatureParams(
  model: string,
  value: number = MODEL_CONFIG.temperature,
): { temperature?: number } {
  return supportsTemperature(model) ? { temperature: value } : {};
}

// ── Client factory ──────────────────────────────────────────────────────────

/**
 * Returns an OpenAI-SDK-compatible client pointed at the configured provider.
 * All LLM call sites use this instead of importing the Replit proxy directly,
 * so swapping providers requires no changes outside this file.
 *
 * Called once at module load in llm.ts; the env is read at that moment.
 * Restart the server to pick up key changes.
 */
export function createLLMClient(): OpenAI {
  if (isOpenRouterConfigured) {
    return meterCompletions(
      new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY!,
        baseURL: MODEL_CONFIG.baseUrl,
        defaultHeaders: {
          // OpenRouter requires these for attribution and rate-limit tiers.
          "HTTP-Referer": "https://potify.repl.co",
          "X-Title": "POTIFY Shortcut Studio",
        },
      }),
    );
  }

  // Replit AI Integrations proxy — credentials injected by the workspace.
  // Falls back to a direct OpenAI key if the env var is set explicitly.
  return meterCompletions(
    new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "proxy",
      baseURL:
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    }),
  );
}

/**
 * Labels a request for the cost ledger. Every structured call already names its
 * JSON schema, and those names are the pipeline stages, so no call site has to
 * pass a stage explicitly and no new stage can be added without being counted.
 */
export function stageLabelOf(body: unknown): string {
  const schema = (body as { response_format?: { json_schema?: { name?: unknown } } })
    ?.response_format?.json_schema?.name;
  if (typeof schema === "string" && schema.length > 0) return schema;
  const model = (body as { model?: unknown })?.model;
  return typeof model === "string" ? `unlabelled:${model}` : "unlabelled";
}

/**
 * Wraps `chat.completions.create` so token usage is recorded centrally.
 *
 * Done here rather than at each call site for two reasons: a new pipeline stage
 * cannot forget to account for itself, and accounting can never alter what the
 * model returned. `assertBudget` is the one thing allowed to throw, and only
 * before a request is issued — a run that has already blown its ceiling must
 * not start another stage. With no ledger installed (every path except a
 * measured generate run) both calls are no-ops.
 */
export function meterCompletions(client: OpenAI): OpenAI {
  const completions = client.chat.completions as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const original = completions.create.bind(completions);

  completions.create = async (...args: unknown[]) => {
    const body = args[0];
    const stage = stageLabelOf(body);
    assertBudget(stage);

    const response = await original(...args);

    try {
      const model = (body as { model?: unknown })?.model;
      recordUsage(
        stage,
        typeof model === "string" ? model : "unknown",
        (response as { usage?: unknown })?.usage,
      );
    } catch {
      // Metering must never break inference.
    }
    return response;
  };

  return client;
}
