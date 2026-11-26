import { createLLMClient, MODEL_CONFIG, temperatureParams } from "./model-config";
import {
  type ShortcutsActionCatalogEntry,
  type ShortcutAction,
  type ShortcutPlist,
  clientVersionToIosString,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_MIN_CLIENT_VERSION,
  ensureActionUuids,
} from "./catalog";
import { type AdapterBlock, adapterText } from "./adapter";
import {
  type ScopedSchemas,
  identifiersInActions,
  selectActionSchemas,
} from "./schema-retrieval";
import { buildPlan, planToShortcut, type Plan } from "./planner";
import type { ValidationFinding } from "./validation";
import {
  generateShortcutSchema,
  explainShortcutSchema,
  repairShortcutSchema,
  suggestNextActionsSchema,
  semanticValidationSchema,
} from "./llm-schemas";

// Module-level client — reads OPENROUTER_API_KEY / AI_INTEGRATIONS_OPENAI_API_KEY
// at startup via model-config.ts. Restart the server to pick up key changes.
const openai = createLLMClient();
const MODEL = MODEL_CONFIG.model;

/**
 * The prompt is assembled from three parts with very different lifetimes:
 *
 *   1. **Fixed policy** (`POLICY_HEAD` + `POLICY_TAIL`) — identical for every
 *      request forever. This is the part `boot.ts` fingerprints, and the part
 *      the immutability guarantee is actually about.
 *   2. **Retrieved schemas** — chosen per request by `selectActionSchemas`, a
 *      pure function of the catalog. Covered by `catalogHash`, not by the
 *      policy hash.
 *   3. **Adapter exemplars** — offline only, and unforgeable in the request
 *      path (see `adapter.ts`).
 *
 * They are kept separate because collapsing them into one hashed blob is what
 * made scoping unsafe before: a per-request schema section inside the
 * fingerprinted string would make the boot fingerprint change on every request,
 * and an integrity check that always fails is an integrity check nobody keeps.
 */
const POLICY_HEAD = `You are an expert iOS Shortcuts builder working inside the POTIFY Shortcut Studio. You generate, explain, and repair Shortcuts workflows by producing valid Shortcuts plist JSON.

PURPOSE:
- You are a deterministic guide that turns natural language into accurate, portable iOS Shortcuts.
- You never invent Apple capabilities. If a user asks for something iOS Shortcuts cannot do, you say so and offer the closest valid alternative.
- You prefer well-known, stable actions over experimental or app-specific actions.
- You reason about device compatibility, permissions, and iOS version floors explicitly.

SHORTCUT PLIST RULES:
- The top-level object is a dictionary with these keys: WFWorkflowClientVersion (string), WFWorkflowMinimumClientVersion (integer), WFWorkflowName (string), WFWorkflowActions (array).
- Each action is a dictionary with: WFWorkflowActionIdentifier (string), WFWorkflowActionParameters (dictionary), and optionally UUID (uppercase string), GroupingIdentifier (string for If/Repeat/Choose grouping).
- Magic variables are not required for v1; use literal values in parameters. If an action needs input from a previous action, bind the parameter to a descriptive string placeholder that matches the previous action's output name.
- Always set WFWorkflowActionParameters, even if empty.
- Control flow: If, Repeat, Choose from Menu, and their End actions must share a matching GroupingIdentifier. Do not overlap groups.
- Data flow: an action that consumes a variable must appear after the action that produces it.

CONTROL FLOW GROUPING — CRITICAL RULES:
The If / Otherwise / End If triad all share THE SAME GroupingIdentifier UUID. This is not a mistake — it is how Apple's plist format works.

Correct structure (the only accepted form):
  { WFWorkflowActionIdentifier: "is.workflow.actions.conditional",         GroupingIdentifier: "SAME-UUID", ... }   ← If (beginsGroup)
  { WFWorkflowActionIdentifier: "is.workflow.actions.showresult", ... }                                             ← if-branch body
  { WFWorkflowActionIdentifier: "is.workflow.actions.conditional.otherwise", GroupingIdentifier: "SAME-UUID", ... } ← Otherwise (same UUID, mid-block marker)
  { WFWorkflowActionIdentifier: "is.workflow.actions.showresult", ... }                                             ← else-branch body
  { WFWorkflowActionIdentifier: "is.workflow.actions.conditional.end",      GroupingIdentifier: "SAME-UUID", ... }  ← End If (same UUID, endsGroup)

Rules:
1. If, Otherwise (optional), and End If MUST share the same GroupingIdentifier.
2. The Otherwise action uses identifier "is.workflow.actions.conditional.otherwise".
3. The End If action uses identifier "is.workflow.actions.conditional.end".
4. Never generate an If without a corresponding End If. Otherwise is optional but must appear between If and End If if used.
5. For Repeat: "is.workflow.actions.repeat.count" and "is.workflow.actions.repeat.count.end" share one GroupingIdentifier.
6. For Choose from Menu: "is.workflow.actions.choosefrommenu" and each "is.workflow.actions.choosefrommenu.option" and the end all share one GroupingIdentifier.

RETRIEVED ACTIONS (identifier, display name, tags, minimum client version, required parameters):`;

const POLICY_TAIL = `INSTRUCTIONS:
- The RETRIEVED ACTIONS list is the subset of the catalog retrieved for this specific request, not the whole catalog. Use identifiers from it.
- Do not invent an identifier. If this request genuinely needs an action that is not listed, say what is missing in your uncertainty output instead of guessing at a plausible identifier.
- Actions marked UNCATALOGUED are third-party or unrecognised. Keep them as-is when repairing or explaining; do not substitute a catalog action for one.
- Respect the minimumClientVersion when choosing actions. If the target iOS version is lower, fall back to older-compatible actions.
- Provide plain-English explanations for each action.
- When repairing, only change what is needed to fix the listed findings; preserve intent and preserve as many original actions as possible.
- For uncertainty, list what is ambiguous and what you assumed.
- Respond only with valid JSON matching the requested schema.`;

let cachedPromptPolicy: string | null = null;

/**
 * The fixed policy text, with no catalog and no adapter in it.
 *
 * This is what gets fingerprinted at boot. It is the honest subject of the
 * "production artifacts are immutable at runtime" guarantee: it contains every
 * instruction the model is held to and nothing that legitimately varies per
 * request. The catalog is covered separately and completely by `catalogHash`,
 * and schema selection is pure, so scoping the prompt cannot move either hash
 * without a real artifact change.
 */
export function buildPromptPolicy(): string {
  if (cachedPromptPolicy) return cachedPromptPolicy;
  cachedPromptPolicy = `${POLICY_HEAD}\n${POLICY_TAIL}`;
  return cachedPromptPolicy;
}

export interface SystemPromptOptions {
  /**
   * Schemas retrieved for this request. Required — there is no "just send
   * everything" default, because that default is what made every explain call
   * as expensive as a generate call.
   */
  schemas: ScopedSchemas;
  /**
   * Offline candidate exemplars. Cannot be constructed by a request path: the
   * only mint lives in the training subtree, which `training-isolation.test.ts`
   * forbids the request path from importing.
   */
  adapter?: AdapterBlock;
}

/**
 * Assembles the system prompt: fixed policy, retrieved schemas, then adapter.
 *
 * The adapter is appended last and nothing before it changes, so the production
 * prompt is an exact prefix of the candidate prompt. That prefix relationship is
 * the strong form of "the adapter only ever adds", and it is asserted rather
 * than asserted-about in `llm-prompt-identity.test.ts`.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { schemas, adapter } = options;

  const uncatalogued =
    schemas.uncatalogued.length > 0
      ? `\n\nUNCATALOGUED IDENTIFIERS present in this request (not in the catalog — preserve, do not substitute):\n${schemas.uncatalogued
          .map((id) => `- ${id}`)
          .join("\n")}`
      : "";

  const text = adapterText(adapter);
  const suffix = text === "" ? "" : `\n\n${text}\n`;

  // Assembled fresh every call. The expensive part (rendering the schema block)
  // is cached inside schema-retrieval, keyed on catalog content only — so there
  // is no cache here that an adapter could ever be written into.
  return `${POLICY_HEAD}\n${schemas.rendered}${uncatalogued}\n\n${POLICY_TAIL}${suffix}`;
}

export interface GenerateResult {
  shortcut: ShortcutPlist;
  actions: Array<{
    actionIndex: number;
    identifier: string;
    displayName: string;
    explanation: string;
    parameterSummary: string;
  }>;
  warnings: ValidationFinding[];
  minimumIosVersion: string;
  explanation: string;
  uncertainty: string[];
  alternatives: Array<{ label: string; description: string }>;
}

function emptyGenerateResult(): Partial<GenerateResult> {
  return {
    warnings: [],
    actions: [],
    uncertainty: [],
    alternatives: [],
  };
}

export async function generateShortcut(
  description: string,
  targetIosVersion?: string,
  slots: Record<string, unknown> = {},
): Promise<GenerateResult> {
  const plan = buildPlan(description, slots, targetIosVersion);
  const targetNote = targetIosVersion
    ? `Target iOS version: ${targetIosVersion}. Only use actions compatible with this version. If the deterministic plan suggests a newer action, replace it with an older-compatible alternative from the catalog.`
    : "Use actions compatible with iOS 26+ unless the user asks for older compatibility.";

  // The planner's identifiers are the floor, and the description broadens the
  // scope around them — a plan that named three actions still gets the
  // neighbourhood of what the user asked for, so scoping cannot make the model
  // *less* able to build what the plan missed.
  const schemas = selectActionSchemas({
    identifiers: plan.steps.map((s) => s.actionIdentifier),
    keywords: `${description} ${plan.goal}`,
    // Generation is the one caller that cannot work with control flow alone.
    requireDomainActions: true,
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokens,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: generateShortcutSchema } as any,
    messages: [
      { role: "system", content: buildSystemPrompt({ schemas }) },
      {
        role: "user",
        content: `Generate an iOS Shortcut based on this description. ${targetNote}

Description: ${description}

A deterministic planner produced this initial plan. Use it as a starting point but improve it. The plan may be incomplete; fill in missing parameters and resolve ambiguity.

Plan:
${JSON.stringify(plan, null, 2)}
`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");
  const parsed = { ...emptyGenerateResult(), ...(JSON.parse(raw) as GenerateResult) };

  if (!parsed.shortcut || !Array.isArray(parsed.shortcut.WFWorkflowActions)) {
    throw new Error("LLM response did not contain a valid shortcut");
  }

  parsed.shortcut.WFWorkflowClientVersion =
    parsed.shortcut.WFWorkflowClientVersion ?? DEFAULT_CLIENT_VERSION;
  parsed.shortcut.WFWorkflowMinimumClientVersion =
    parsed.shortcut.WFWorkflowMinimumClientVersion ?? DEFAULT_MIN_CLIENT_VERSION;
  parsed.shortcut.WFWorkflowName =
    parsed.shortcut.WFWorkflowName ?? "POTIFY Shortcut";
  ensureActionUuids(parsed.shortcut.WFWorkflowActions);

  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  parsed.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  parsed.minimumIosVersion =
    parsed.minimumIosVersion ??
    clientVersionToIosString(parsed.shortcut.WFWorkflowMinimumClientVersion ?? DEFAULT_MIN_CLIENT_VERSION);
  parsed.explanation = parsed.explanation ?? "";
  parsed.uncertainty = Array.isArray(parsed.uncertainty) ? parsed.uncertainty : [];
  parsed.alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];

  return parsed as GenerateResult;
}

export interface ExplainResult {
  steps: Array<{
    actionIndex: number;
    identifier: string;
    displayName: string;
    explanation: string;
    parameterSummary: string;
  }>;
  summary: string;
  dataFlow: string;
  compatibility: string;
}

export async function explainShortcut(shortcut: ShortcutPlist): Promise<ExplainResult> {
  // Explaining needs the schemas of the actions actually present, nothing more.
  // A shortcut made entirely of third-party actions is legitimate here, so this
  // must not require a domain action — those identifiers are declared to the
  // model as UNCATALOGUED instead.
  const schemas = selectActionSchemas({
    identifiers: identifiersInActions(shortcut.WFWorkflowActions ?? []),
    keywords: shortcut.WFWorkflowName ?? "",
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokens,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: explainShortcutSchema } as any,
    messages: [
      { role: "system", content: buildSystemPrompt({ schemas }) },
      {
        role: "user",
        content: `Explain this iOS Shortcut in plain English, action by action. Include a data-flow summary and compatibility notes.

Shortcut: ${JSON.stringify(shortcut)}
`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");
  return JSON.parse(raw) as ExplainResult;
}

export interface RepairResult {
  shortcut: ShortcutPlist;
  changelog: Array<{
    actionIndex: number;
    changeType: "modified" | "removed" | "added";
    description: string;
  }>;
  unresolved: string[];
  alternatives: Array<{ label: string; description: string }>;
}

export async function repairShortcut(
  shortcut: ShortcutPlist,
  findings: ValidationFinding[],
  targetIosVersion?: string,
): Promise<RepairResult> {
  const schemaFindings = findings.filter((f) => f.source === "schema" && f.severity !== "info");
  const infoFindings = findings.filter((f) => f.source === "ai" || f.severity === "info");

  // Repair reasons about the actions present plus whatever the findings talk
  // about — a finding that says an action is unavailable needs its replacement
  // candidates in scope, which is what ranking the finding text supplies.
  const schemas = selectActionSchemas({
    identifiers: identifiersInActions(shortcut.WFWorkflowActions ?? []),
    keywords: [
      shortcut.WFWorkflowName ?? "",
      ...findings.map((f) => `${f.message} ${f.suggestion ?? ""}`),
    ].join(" "),
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokens,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: repairShortcutSchema } as any,
    messages: [
      { role: "system", content: buildSystemPrompt({ schemas }) },
      {
        role: "user",
        content: `Repair this iOS Shortcut based on the validation findings. Preserve the original intent and only change what is needed to fix the issues. ${targetIosVersion ? `Target iOS version: ${targetIosVersion}.` : ""}

Shortcut: ${JSON.stringify(shortcut)}

Findings: ${JSON.stringify(schemaFindings)}

Informational notes: ${JSON.stringify(infoFindings)}
`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");
  const parsed = JSON.parse(raw) as RepairResult;
  ensureActionUuids(parsed.shortcut.WFWorkflowActions);
  parsed.changelog = Array.isArray(parsed.changelog) ? parsed.changelog : [];
  parsed.unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
  parsed.alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];
  return parsed;
}

export interface SuggestResult {
  suggestions: Array<{
    identifier: string;
    displayName: string;
    rationale: string;
    parameters: Record<string, unknown>;
  }>;
}

export async function suggestNextActions(
  actions: ShortcutAction[],
  context?: string,
): Promise<SuggestResult> {
  // Suggestion is the one caller that genuinely benefits from breadth — it has
  // to propose actions that are NOT yet in the workflow — so it gets a wider
  // budget. An empty builder is a normal state, so no domain action is required.
  const schemas = selectActionSchemas({
    identifiers: identifiersInActions(actions ?? []),
    keywords: [
      context ?? "",
      ...(actions ?? []).map((a) => a.WFWorkflowActionIdentifier),
    ].join(" "),
    limit: 72,
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokensFast,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: suggestNextActionsSchema } as any,
    messages: [
      { role: "system", content: buildSystemPrompt({ schemas }) },
      {
        role: "user",
        content: `Given the current partial iOS Shortcut, suggest 3 good next actions to continue the workflow. Prefer stable, well-known actions. If the last action produces an output, suggest actions that can consume that output.

Current actions: ${JSON.stringify(actions)}
${context ? `Additional context: ${context}` : ""}
`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");
  return JSON.parse(raw) as SuggestResult;
}

export async function semanticValidation(
  shortcut: ShortcutPlist,
): Promise<ValidationFinding[]> {
  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokensFast,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: semanticValidationSchema } as any,
    messages: [
      {
        role: "system",
        content: `You are a careful iOS Shortcuts reviewer inside the POTIFY Shortcut Studio. Provide semantic warnings about the shortcut: odd flows, likely runtime failures, missing permissions, logic issues, or over-claimed Apple capabilities. Respond only with JSON. Each warning must have severity "warning" or "info", source "ai", an actionIndex if relevant, a message, and an optional suggestion.`,
      },
      {
        role: "user",
        content: `Review this shortcut for semantic/logical issues.

Shortcut: ${JSON.stringify(shortcut)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { findings: ValidationFinding[] };
  return parsed.findings ?? [];
}

export { buildPlan, planToShortcut };
export type { Plan };
