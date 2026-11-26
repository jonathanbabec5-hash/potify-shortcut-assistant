/**
 * Smoke test for the model configuration and LLM client factory.
 *
 * This is an INTEGRATION test — it makes a real network call to the configured
 * LLM provider. It is intentionally separate from the unit test suite so it
 * does not run on every `pnpm test` invocation.
 *
 * Run it manually:
 *   pnpm --filter @workspace/api-server exec node --import=tsx --test \
 *     src/lib/shortcuts/model-config.test.ts
 *
 * Requirements:
 *   - OPENROUTER_API_KEY must be set (for OpenRouter mode), OR
 *   - AI_INTEGRATIONS_OPENAI_API_KEY + AI_INTEGRATIONS_OPENAI_BASE_URL (Replit proxy mode)
 *
 * What it checks:
 *   1. MODEL_CONFIG fields are valid (non-empty strings, positive integers).
 *   2. createLLMClient() returns an OpenAI-compatible client instance.
 *   3. The client responds to a trivial one-line JSON prompt within 30 s.
 *   4. The response contains a parseable JSON object (non-empty).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CONFIG, createLLMClient } from "./model-config";

// ── Unit checks (no network) ──────────────────────────────────────────────────

test("MODEL_CONFIG has required fields with valid values", () => {
  assert.ok(typeof MODEL_CONFIG.model === "string" && MODEL_CONFIG.model.length > 0,
    "model must be a non-empty string");
  assert.ok(typeof MODEL_CONFIG.reasoningModel === "string" && MODEL_CONFIG.reasoningModel.length > 0,
    "reasoningModel must be a non-empty string");
  assert.ok(MODEL_CONFIG.maxCompletionTokens > 0,
    "maxCompletionTokens must be positive");
  assert.ok(MODEL_CONFIG.maxCompletionTokensFast > 0,
    "maxCompletionTokensFast must be positive");
  assert.ok(MODEL_CONFIG.maxCompletionTokensFast < MODEL_CONFIG.maxCompletionTokens,
    "fast token budget must be smaller than the standard budget");
  assert.ok(MODEL_CONFIG.temperature >= 0 && MODEL_CONFIG.temperature <= 1,
    "temperature must be between 0 and 1");
  assert.ok(MODEL_CONFIG.baseUrl.startsWith("http"),
    "baseUrl must be a valid URL");
  assert.ok(
    MODEL_CONFIG.provider === "openrouter" || MODEL_CONFIG.provider === "replit-proxy",
    "provider must be a known value",
  );
  console.log("[model-config] Active configuration:", {
    provider: MODEL_CONFIG.provider,
    model: MODEL_CONFIG.model,
    baseUrl: MODEL_CONFIG.baseUrl,
    maxCompletionTokens: MODEL_CONFIG.maxCompletionTokens,
  });
});

test("createLLMClient returns an object with a chat.completions.create method", () => {
  const client = createLLMClient();
  assert.ok(client !== null && typeof client === "object", "client must be an object");
  assert.ok(
    typeof (client as any)?.chat?.completions?.create === "function",
    "client must have chat.completions.create",
  );
});

// ── Integration check (network call) ─────────────────────────────────────────

test("LLM client returns parseable JSON for a trivial prompt", { timeout: 30_000 }, async () => {
  const client = createLLMClient();

  const response = await client.chat.completions.create({
    model: MODEL_CONFIG.model,
    max_completion_tokens: 128,
    messages: [
      {
        role: "user",
        content:
          'Respond with exactly this JSON and nothing else: {"ok":true,"message":"smoke test passed"}',
      },
    ],
    // Not using json_schema here — this is a provider-agnostic smoke test.
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content;
  assert.ok(
    typeof raw === "string" && raw.trim().length > 0,
    `Expected a non-empty string response, got: ${JSON.stringify(raw)}`,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    assert.fail(`LLM returned non-JSON content: ${raw}`);
  }

  assert.ok(
    parsed !== null && typeof parsed === "object",
    `Expected a JSON object, got: ${JSON.stringify(parsed)}`,
  );

  console.log("[model-config] Smoke test response:", {
    provider: MODEL_CONFIG.provider,
    model: MODEL_CONFIG.model,
    responseLength: raw.length,
    content: parsed,
    usage: response.usage,
  });
});

