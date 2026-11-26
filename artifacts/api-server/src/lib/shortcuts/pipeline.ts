/**
 * Six-stage generation pipeline for POTIFY Shortcut Studio.
 *
 * Stage 1 — Intent Extraction    → Locked IntentChecklist (LLM)
 * Stage 2 — Schema Retrieval     → RetrievedSchemas (deterministic)
 * Stage 3 — IR Generation        → WorkflowIR (LLM)
 * Stage 4 — IR Validation        → IRValidationError[] (deterministic)
 * Stage 5 — Plist Serialisation  → ShortcutPlist (deterministic)
 * Stage 6 — Plist Validation + Seal (deterministic)
 */

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createLLMClient, MODEL_CONFIG, temperatureParams } from "./model-config";
import {
  type ShortcutsActionCatalogEntry,
  type ShortcutAction,
  type ShortcutPlist,
  getActionByIdentifier,
  ensureActionUuids,
  clientVersionToIosString,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_MIN_CLIENT_VERSION,
} from "./catalog";
import { type AdapterBlock, adapterText } from "./adapter";
import { validateShortcut } from "./validation";
import type { ValidationFinding } from "./validation";
import { checkCompletion } from "./completion";
import type { CompletionResult } from "./completion";
import { storeShortcut } from "./store";
import type {
  IntentChecklist,
  IntentChecklistItem,
  WorkflowIR,
  IRStep,
  IRBlock,
  IRValidationError,
  RetrievedSchemas,
  PipelineResult,
} from "./pipeline-types";
import type { ActionExplanation } from "./types";
import { extractChecklistSchema, generateIRSchema } from "./llm-schemas";

const openai = createLLMClient();
const MODEL = MODEL_CONFIG.model;

/**
 * Stage 1 only. Intent extraction is where a mistake is most expensive — the
 * checklist it produces is locked and every later stage is judged against it,
 * so an error here is not recoverable downstream. This is the one step that
 * justifies a stronger (and pricier) model; everything else runs on MODEL.
 *
 * Resolves to the same model as MODEL unless OPENROUTER_REASONING_MODEL is set,
 * so enabling a reasoning model is a configuration change, not a code change.
 */
const REASONING_MODEL = MODEL_CONFIG.reasoningModel;

// ── External domain patterns ──────────────────────────────────────────────────
// Identifiers matching these patterns are known third-party/uncatalogued domains.
// Stage 2 marks them "external" rather than hard-failing.
const EXTERNAL_DOMAIN_PATTERNS: RegExp[] = [
  /homekit|controlhome|homescene|accessory|characteristic/i,
  /\bnfc\b/i,
];

function isExternalDomain(identifier: string): boolean {
  return EXTERNAL_DOMAIN_PATTERNS.some((p) => p.test(identifier));
}

// ── Confirmed user answers ────────────────────────────────────────────────────

/**
 * Values the user supplied in the clarification dialog, keyed by slot.
 *
 * These are confirmed facts, not guesses: the user was asked a direct question
 * and answered it. Every stage that can act on them must do so, and
 * verifySlotsApplied() blocks the result if an answer never reaches the plist.
 */
export type ConfirmedSlots = Record<string, unknown>;

/** Drops missing/blank entries so an empty answer never looks like a real one. */
function normalizeSlots(slots: ConfirmedSlots): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(slots ?? {})) {
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "string" ? raw.trim() : String(raw);
    if (value.length === 0) continue;
    entries.push({ key, value });
  }
  return entries;
}

/** Renders confirmed answers for inclusion in an LLM prompt. */
function describeSlots(slots: ConfirmedSlots): string | undefined {
  const entries = normalizeSlots(slots);
  if (entries.length === 0) return undefined;
  return entries.map(({ key, value }) => `- ${key}: ${value}`).join("\n");
}

// ── Stage 1: Intent Extraction → Locked IntentChecklist ──────────────────────

export async function extractChecklist(
  description: string,
  slots: ConfirmedSlots = {},
): Promise<IntentChecklist> {
  const confirmed = describeSlots(slots);
  const userContent = confirmed
    ? `Extract the intent checklist for this iOS Shortcut:\n\n${description}\n\n` +
      `The user was asked follow-up questions and gave these answers. Treat them as ` +
      `confirmed requirements — fold them into the checklist items (as operand, ` +
      `operator, threshold, or in the description) and never contradict or ignore them:\n${confirmed}`
    : `Extract the intent checklist for this iOS Shortcut:\n\n${description}`;

  const response = await openai.chat.completions.create({
    model: REASONING_MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokensFast,
    ...temperatureParams(REASONING_MODEL, 0),
    response_format: { type: "json_schema", json_schema: extractChecklistSchema } as any,
    messages: [
      {
        role: "system",
        content: `You are an iOS Shortcuts analyst. Extract a precise, locked intent checklist from a user description.

For each discrete requirement produce one item:
  "condition" — something the shortcut must CHECK at runtime (distance, time, battery, state, etc.)
  "action"    — something the shortcut must DO (send, set, save, open, etc.)
  "constraint" — a platform/permission constraint (requires HomeKit, requires iOS 16+, etc.)

Rules:
- Be specific. "check distance to home" is better than "check location".
- requiredActions must contain valid iOS Shortcuts action identifiers OR capability patterns for
  third-party domains (e.g. "homekit.getstate", "homekit.setstate").
- For HomeKit, smart-home, or NFC actions, set externalDomain: true.
- If a requirement is ambiguous, set needsClarification: true.
- NEVER suggest "is.workflow.actions.comment" as an implementation.
- Assign short stable IDs (e.g. "IC-proximity", "IC-sunset", "IC-lights-on").
- Only produce items the user actually described. Do NOT add conditions, loops, or
  actions they did not ask for, and never invent a threshold they did not state.
- Answers the user gave to follow-up questions are confirmed requirements. Use them
  verbatim; do not substitute your own value for one they supplied.
- Respond only with valid JSON matching the schema.`,
      },
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response for Stage 1 (extractChecklist)");

  let parsed: { items: IntentChecklistItem[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Stage 1 returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error("Stage 1 returned no checklist items");
  }

  const items = Object.freeze(parsed.items) as IntentChecklistItem[];
  const hash = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
  return Object.freeze({ items, hash, lockedAt: Date.now() }) as IntentChecklist;
}

// ── Stage 2: Schema Retrieval ─────────────────────────────────────────────────

export interface SchemaRetrievalResult {
  schemas: RetrievedSchemas;
  failures: Array<{ identifier: string; checklistItemId: string; message: string }>;
}

export function retrieveSchemas(checklist: IntentChecklist): SchemaRetrievalResult {
  const schemas: RetrievedSchemas = new Map();
  const failures: SchemaRetrievalResult["failures"] = [];

  for (const item of checklist.items) {
    for (const identifier of item.requiredActions) {
      if (schemas.has(identifier)) continue;

      const entry = getActionByIdentifier(identifier);
      if (entry) {
        schemas.set(identifier, entry);
      } else if (isExternalDomain(identifier) || item.externalDomain) {
        // Known third-party domain (HomeKit, NFC, etc.) — pass through.
        // sealChecklist still does per-item pattern matching against this identifier.
        schemas.set(identifier, "external");
      } else {
        // Truly unknown identifier — does NOT match any known domain.
        // Do NOT add to schemas so Stage 4 grounding check emits a hard error.
        failures.push({
          identifier,
          checklistItemId: item.id,
          message: `**[Action unavailable]** "${identifier}" required by "${item.description}" is not in the Shortcuts catalog and does not match a known external domain. It may be a typo.`,
        });
      }
    }
  }

  return { schemas, failures };
}

// ── Stage 3: Typed WorkflowIR Generation (LLM) ───────────────────────────────

export async function generateIR(
  checklist: IntentChecklist,
  schemas: RetrievedSchemas,
  targetIosVersion?: string,
  slots: ConfirmedSlots = {},
  /**
   * Offline candidate exemplars.
   *
   * Typed as `AdapterBlock`, which no request path can construct — the only mint
   * lives in the training subtree. Previously this was a plain string defaulting
   * to `""`, which meant safety rested on every caller remembering not to pass
   * anything. Now a caller that wants to pass something has to obtain a value it
   * structurally cannot obtain.
   */
  adapter?: AdapterBlock,
): Promise<WorkflowIR> {
  // Build schema context for the prompt
  const schemaContext: Record<string, unknown> = {};
  for (const [identifier, entry] of schemas) {
    if (entry === "external") {
      schemaContext[identifier] = {
        note: "Third-party / uncatalogued action — use the most accurate identifier you know",
      };
    } else {
      schemaContext[identifier] = {
        displayName: entry.displayName,
        description: entry.description,
        minimumClientVersion: entry.minimumClientVersion,
        requiredParameters: entry.parameters.required.map((p) => ({
          key: p.key,
          displayName: p.displayName,
          type: p.type,
        })),
        controlFlow: entry.controlFlow,
      };
    }
  }

  const targetNote = targetIosVersion
    ? `Target iOS version: ${targetIosVersion}. Only use actions compatible with this version.`
    : "Target iOS 16+ unless the checklist item requires newer features.";

  const confirmed = describeSlots(slots);

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MODEL_CONFIG.maxCompletionTokens,
    ...temperatureParams(MODEL),
    response_format: { type: "json_schema", json_schema: generateIRSchema } as any,
    messages: [
      {
        role: "system",
        content: `You are an iOS Shortcuts IR generator. You receive a locked intent checklist and action schemas, and produce a WorkflowIR — a typed intermediate representation.

CRITICAL RULES:
1. Every step MUST be justified by a checklist item. Set justifiedByItemId to the item's id.
2. Never use "is.workflow.actions.comment" as an implementation.
3. iOS Shortcuts can only test ONE condition per If block. For AND conditions, use NESTED If blocks.
4. Variables: declare every variable in the variables array before referencing it.
5. satisfies must list every item id you have fully implemented.
6. Step IDs must be unique (use "s1", "s2", etc.).
7. ir.steps contains ONLY the logical action steps in execution order.
   Do NOT include Otherwise or End-If entries in ir.steps — the serializer adds those.
8. The conditionStepId of an IRBlock is the step that EVALUATES the condition (the If opener step, 
   which will become is.workflow.actions.conditional in the plist).
   The thenSteps are the step IDs that run INSIDE the If branch.
   Nested block condition steps ARE listed in the parent's thenSteps.
9. Values the user supplied in answer to a follow-up question are confirmed facts.
   Bind them as literal parameter values exactly as given. Never replace a supplied
   value with a placeholder or an example of your own.

${targetNote}${adapterText(adapter) === "" ? "" : `\n\n${adapterText(adapter)}`}`,
      },
      {
        role: "user",
        content: `Generate a WorkflowIR for this locked checklist.

CHECKLIST (locked — do not modify):
${JSON.stringify(checklist.items, null, 2)}

AVAILABLE ACTION SCHEMAS:
${JSON.stringify(schemaContext, null, 2)}
${
  confirmed
    ? `\nCONFIRMED USER ANSWERS (bind these exact values as literals):\n${confirmed}\n`
    : ""
}
Requirements:
- For each "condition" checklist item, create a nested If block (conditionStepId = the step that does the check).
- For each "action" checklist item, place the implementing step(s) inside the innermost relevant If branch.
- Steps before the first condition (location fetch, sunrise fetch, etc.) belong in ir.steps but NOT in any block's thenSteps.
- If you cannot satisfy a checklist item, add it to unsatisfiedItems with a reason.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response for Stage 3 (generateIR)");

  let parsed: WorkflowIR;
  try {
    parsed = JSON.parse(raw) as WorkflowIR;
  } catch {
    throw new Error(`Stage 3 returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error("Stage 3 IR missing steps array");
  }
  if (!Array.isArray(parsed.controlFlow)) {
    parsed.controlFlow = [];
  }
  if (!Array.isArray(parsed.variables)) {
    parsed.variables = [];
  }
  if (!Array.isArray(parsed.satisfies)) {
    parsed.satisfies = [];
  }

  return parsed;
}

// ── Stage 4: Deterministic IR Validation ─────────────────────────────────────

export function validateIR(
  ir: WorkflowIR,
  checklist: IntentChecklist,
  schemas: RetrievedSchemas,
  targetIosVersion?: string,
): IRValidationError[] {
  const errors: IRValidationError[] = [];
  const stepMap = new Map(ir.steps.map((s) => [s.id, s]));
  const variableMap = new Map(ir.variables.map((v) => [v.id, v]));
  const stepIndexMap = new Map(ir.steps.map((s, i) => [s.id, i]));

  // ── Check 1: Action grounding ─────────────────────────────────────────────
  for (const step of ir.steps) {
    if (!schemas.has(step.actionIdentifier)) {
      errors.push({
        stage: "grounding",
        stepId: step.id,
        message: `**[Action unavailable]** Step "${step.id}" uses identifier "${step.actionIdentifier}" which is not in the retrieved schemas. Add it to a checklist item's requiredActions.`,
        suggestion: `Verify "${step.actionIdentifier}" is a valid iOS Shortcuts identifier or mark the checklist item externalDomain: true.`,
        advisory: false,
      });
    }
    if (step.actionIdentifier === "is.workflow.actions.comment") {
      errors.push({
        stage: "grounding",
        stepId: step.id,
        message: "**[Comment substitution]** A Comment action cannot substitute for a real capability.",
        suggestion: "Replace the Comment with a real action from the catalog.",
        advisory: false,
      });
    }
  }

  // ── Check 2: Parameter binding ────────────────────────────────────────────
  for (const step of ir.steps) {
    const schemaEntry = schemas.get(step.actionIdentifier);
    if (!schemaEntry || schemaEntry === "external") continue;

    for (const requiredParam of schemaEntry.parameters.required) {
      // WFControlFlowMode is injected by the serializer — skip
      if (requiredParam.key === "WFControlFlowMode") continue;

      const bound = step.parameterBindings.find((b) => b.key === requiredParam.key);
      if (!bound) {
        errors.push({
          stage: "parameters",
          stepId: step.id,
          message: `**[Parameter unresolvable]** "${schemaEntry.displayName}" requires "${requiredParam.displayName}" (${requiredParam.key}) but no binding was provided.`,
          suggestion: `Add a parameterBinding with key "${requiredParam.key}" to step "${step.id}".`,
          advisory: true,
        });
      }
    }
  }

  // ── Check 3: Variable integrity ───────────────────────────────────────────
  for (const step of ir.steps) {
    for (const binding of step.parameterBindings) {
      if (binding.source !== "variable" || !binding.variableId) continue;

      if (!variableMap.has(binding.variableId)) {
        errors.push({
          stage: "variables",
          stepId: step.id,
          message: `Step "${step.id}" references undeclared variable "${binding.variableId}".`,
          suggestion: "Add the variable to WorkflowIR.variables before referencing it.",
          advisory: false,
        });
        continue;
      }

      const variable = variableMap.get(binding.variableId)!;
      const producerIdx = stepIndexMap.get(variable.producedByStep) ?? -1;
      const consumerIdx = stepIndexMap.get(step.id) ?? -1;
      if (producerIdx >= consumerIdx) {
        errors.push({
          stage: "variables",
          stepId: step.id,
          message: `Step "${step.id}" consumes variable "${binding.variableId}" before it is produced by step "${variable.producedByStep}".`,
          suggestion: "Reorder ir.steps so the producing step appears before the consuming step.",
          advisory: false,
        });
      }
    }
  }

  // ── Check 4: Control flow structure ──────────────────────────────────────
  function validateBlock(block: IRBlock, depth: number): void {
    if (!stepMap.has(block.conditionStepId)) {
      errors.push({
        stage: "controlflow",
        message: `IRBlock at depth ${depth} references conditionStepId "${block.conditionStepId}" which is not in ir.steps.`,
        suggestion: "Add a step with this ID to ir.steps.",
        advisory: false,
      });
    }
    for (const id of [...block.thenSteps, ...block.elseSteps]) {
      if (!stepMap.has(id)) {
        errors.push({
          stage: "controlflow",
          message: `IRBlock at depth ${depth} references step "${id}" in thenSteps/elseSteps which is not in ir.steps.`,
          suggestion: "Add a step with this ID to ir.steps.",
          advisory: false,
        });
      }
    }
    for (const nested of block.nestedBlocks ?? []) {
      validateBlock(nested, depth + 1);
    }
  }
  for (const block of ir.controlFlow) {
    validateBlock(block, 1);
  }

  // ── Check 5: Checklist coverage ───────────────────────────────────────────
  for (const item of checklist.items) {
    if (item.type === "constraint") continue;
    if (!ir.satisfies.includes(item.id)) {
      errors.push({
        stage: "checklist",
        checklistItemId: item.id,
        message: `Checklist item "${item.id}" ("${item.description}") is not in ir.satisfies.`,
        suggestion: `Either add "${item.id}" to ir.satisfies (if you implemented it) or to unsatisfiedItems (if you could not).`,
        advisory: false,
      });
    }
  }

  // ── Check 6: Platform constraints ────────────────────────────────────────
  if (targetIosVersion) {
    const [targetMajor] = targetIosVersion.split(".").map(Number);
    const targetClientVersion = targetMajor >= 26 ? 2702 : targetMajor >= 15 ? 1500 : 1300;
    for (const step of ir.steps) {
      const entry = schemas.get(step.actionIdentifier);
      if (!entry || entry === "external") continue;
      if (entry.minimumClientVersion > targetClientVersion) {
        errors.push({
          stage: "platform",
          stepId: step.id,
          message: `Action "${entry.displayName}" requires iOS ${clientVersionToIosString(entry.minimumClientVersion)} (clientVersion ${entry.minimumClientVersion}) but target is ${targetIosVersion}.`,
          suggestion: `Raise the target iOS version or use an older-compatible action.`,
          advisory: true,
        });
      }
    }
  }

  // ── Check 7: Invented logic prohibition ──────────────────────────────────
  const allRequiredIdentifiers = new Set<string>();
  for (const item of checklist.items) {
    for (const id of item.requiredActions) {
      allRequiredIdentifiers.add(id.toLowerCase());
    }
  }

  for (const step of ir.steps) {
    const hasJustification =
      step.justifiedByItemId !== undefined ||
      Array.from(allRequiredIdentifiers).some((reqId) => {
        const stepLower = step.actionIdentifier.toLowerCase();
        if (stepLower === reqId) return true;
        const shortReq = reqId.split(".").pop() ?? reqId;
        if (stepLower.includes(shortReq)) return true;
        return false;
      });

    if (!hasJustification) {
      errors.push({
        stage: "invention",
        stepId: step.id,
        message: `**[Invented logic]** Step "${step.id}" ("${step.actionIdentifier}") is not required by any checklist item.`,
        suggestion: "Remove this step or add a checklist item that requires it.",
        advisory: true,
      });
    }
  }

  return errors;
}

// ── Stage 5: IR → Plist Serialisation ────────────────────────────────────────

function irStepToAction(step: IRStep): ShortcutAction {
  const params: Record<string, unknown> = {};
  for (const binding of step.parameterBindings) {
    if (binding.value !== null && binding.value !== undefined) {
      params[binding.key] = binding.value;
    }
  }
  return {
    WFWorkflowActionIdentifier: step.actionIdentifier,
    WFWorkflowActionParameters: params,
  };
}

function collectAllBlockStepIds(blocks: IRBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    ids.add(block.conditionStepId);
    for (const id of block.thenSteps) ids.add(id);
    for (const id of block.elseSteps) ids.add(id);
    for (const nestedId of collectAllBlockStepIds(block.nestedBlocks ?? [])) {
      ids.add(nestedId);
    }
  }
  return ids;
}

function serializeBranch(
  stepIds: string[],
  nestedBlocks: IRBlock[],
  stepMap: Map<string, IRStep>,
): ShortcutAction[] {
  const nestedByCondId = new Map((nestedBlocks ?? []).map((b) => [b.conditionStepId, b]));
  const result: ShortcutAction[] = [];
  for (const stepId of stepIds) {
    const nestedBlock = nestedByCondId.get(stepId);
    if (nestedBlock) {
      result.push(...serializeBlock(nestedBlock, stepMap));
    } else {
      const step = stepMap.get(stepId);
      if (step) result.push(irStepToAction(step));
    }
  }
  return result;
}

function serializeBlock(block: IRBlock, stepMap: Map<string, IRStep>): ShortcutAction[] {
  const groupId = uuidv4().toUpperCase();
  const result: ShortcutAction[] = [];

  // Condition step → If opener
  const condStep = stepMap.get(block.conditionStepId);
  if (condStep) {
    const action = irStepToAction(condStep);
    action.GroupingIdentifier = groupId;
    action.WFWorkflowActionParameters = {
      ...action.WFWorkflowActionParameters,
      WFControlFlowMode: 0,
    };
    result.push(action);
  }

  // Then-branch
  result.push(...serializeBranch(block.thenSteps, block.nestedBlocks ?? [], stepMap));

  // Else-branch (only when non-empty)
  if (block.elseSteps.length > 0) {
    result.push({
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional.otherwise",
      WFWorkflowActionParameters: { WFControlFlowMode: 1 },
      GroupingIdentifier: groupId,
    });
    result.push(...serializeBranch(block.elseSteps, [], stepMap));
  }

  // End If
  result.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.conditional.end",
    WFWorkflowActionParameters: { WFControlFlowMode: 2 },
    GroupingIdentifier: groupId,
  });

  return result;
}

export function irToShortcut(ir: WorkflowIR, name?: string): ShortcutPlist {
  const stepMap = new Map(ir.steps.map((s) => [s.id, s]));
  const allBlockIds = collectAllBlockStepIds(ir.controlFlow);
  const topLevelCondIds = new Set(ir.controlFlow.map((b) => b.conditionStepId));

  const actions: ShortcutAction[] = [];

  for (const step of ir.steps) {
    if (topLevelCondIds.has(step.id)) {
      // Top-level block condition step — serialize its entire block
      const block = ir.controlFlow.find((b) => b.conditionStepId === step.id)!;
      actions.push(...serializeBlock(block, stepMap));
    } else if (!allBlockIds.has(step.id)) {
      // Preamble / postscript step — emit directly
      actions.push(irStepToAction(step));
    }
    // else: inside a block but not a condition step — handled by serializeBlock recursion
  }

  ensureActionUuids(actions);

  return {
    WFWorkflowClientVersion: DEFAULT_CLIENT_VERSION,
    WFWorkflowMinimumClientVersion: DEFAULT_MIN_CLIENT_VERSION,
    WFWorkflowName: (name ?? ir.goal ?? "POTIFY Shortcut").slice(0, 60),
    WFWorkflowActions: actions,
  };
}

// ── Stage 6: Plist Validation + Checklist Seal ────────────────────────────────

export interface SealResult {
  satisfied: boolean;
  unsatisfiedItems: IntentChecklistItem[];
}

export function sealChecklist(
  checklist: IntentChecklist,
  plist: ShortcutPlist,
  ir: WorkflowIR,
): SealResult {
  const unsatisfied: IntentChecklistItem[] = [];
  const actions = plist.WFWorkflowActions ?? [];
  const identifiers = actions.map((a) => a.WFWorkflowActionIdentifier.toLowerCase());

  for (const item of checklist.items) {
    if (item.type === "constraint") continue;

    // Must be in ir.satisfies
    if (!ir.satisfies.includes(item.id)) {
      unsatisfied.push(item);
      continue;
    }

    // Must have a real (non-Comment) plist action matching one of the requiredActions patterns.
    // For externalDomain items, we're more lenient (any non-Comment non-control-flow action).
    if (item.externalDomain) {
      // Per-item pattern match for external-domain actions.
      // Split each requiredActions identifier on . _ - to get capability tokens
      // (e.g. "homekit.setstate" → ["homekit", "setstate"]) and require at least
      // one non-comment, non-synthetic plist action to match one of those tokens.
      const SYNTHETIC = ["comment", "conditional.end", "conditional.otherwise", "repeat.count.end"];
      const hasMatch = item.requiredActions.some((reqId) => {
        const tokens = reqId.toLowerCase().split(/[._\-]/);
        return identifiers.some((id) => {
          if (SYNTHETIC.some((s) => id.includes(s))) return false;
          return tokens.some((tok) => tok.length >= 3 && id.includes(tok));
        });
      });
      if (!hasMatch) {
        unsatisfied.push(item);
      }
      continue;
    }

    const hasMatch = item.requiredActions.some((reqId) => {
      const reqLower = reqId.toLowerCase();
      // Exact match
      if (identifiers.includes(reqLower)) return true;
      // Short suffix match (e.g. "getdistance" in "is.workflow.actions.getdistance")
      const short = reqLower.split(".").pop() ?? reqLower;
      return identifiers.some((id) => id.includes(short));
    });

    if (!hasMatch) {
      unsatisfied.push(item);
    }
  }

  return {
    satisfied: unsatisfied.length === 0,
    unsatisfiedItems: unsatisfied,
  };
}

// ── Slot application check ────────────────────────────────────────────────────

export interface UnappliedSlot {
  key: string;
  value: string;
}

/**
 * Verifies that every value the user supplied actually reached the plist.
 *
 * The user is asked a direct question ("who should receive the message?"), so an
 * answer that never appears in the output means the shortcut does not build what
 * they described. Prompt instructions alone cannot guarantee this, so it is
 * checked deterministically and gated on.
 *
 * Matching is token-based rather than exact: a supplied "battery below 20%" is
 * legitimately serialised as a getbatterylevel action plus a numeric threshold,
 * so requiring the whole phrase verbatim would reject correct output. At least
 * one token of three or more characters (or any number) must appear in the
 * output. Values with no such token are unverifiable and are skipped rather than
 * reported as failures.
 *
 * The haystack is split by kind, because the two halves need different matching
 * rules and a single substring search over both was wrong in one direction:
 *
 *   - Parameter values are natural text, so tokens must match whole words.
 *     Plain substring matching let a recipient "Ann" pass against an unrelated
 *     "Banner" elsewhere in the plist, which is a false pass on the one
 *     guarantee this function exists to provide.
 *   - Action identifiers concatenate words (`getbatterylevel`), so tokens are
 *     matched as substrings there, with a 4-character floor to avoid noise.
 */
export function verifySlotsApplied(
  plist: ShortcutPlist,
  slots: ConfirmedSlots,
): UnappliedSlot[] {
  const entries = normalizeSlots(slots);
  if (entries.length === 0) return [];

  const actions = plist.WFWorkflowActions ?? [];
  const identifierText = actions
    .map((a) => a.WFWorkflowActionIdentifier ?? "")
    .join(" ")
    .toLowerCase();
  const parameterTokens = new Set(
    JSON.stringify(actions.map((a) => a.WFWorkflowActionParameters ?? {}))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  const isPresent = (token: string): boolean =>
    parameterTokens.has(token) || (token.length >= 4 && identifierText.includes(token));

  const unapplied: UnappliedSlot[] = [];

  for (const { key, value } of entries) {
    const tokens = value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 || /^\d+$/.test(t));

    // Nothing substantial enough to look for — cannot verify either way.
    if (tokens.length === 0) continue;

    if (!tokens.some(isPresent)) {
      unapplied.push({ key, value });
    }
  }

  return unapplied;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * The production entry point. Routes call this and only this.
 *
 * It has **no adapter parameter at all** — not an optional one, not one
 * defaulting to empty. There is no argument a request handler could pass, wrong
 * or otherwise, that would put candidate content into a live prompt. Offline
 * measurement goes through `runPipelineForBenchmark`, which requires an
 * `AdapterBlock` that the request path cannot construct.
 */
export async function runPipeline(
  description: string,
  targetIosVersion?: string,
  slots: ConfirmedSlots = {},
): Promise<PipelineResult> {
  return runPipelineInternal(description, targetIosVersion, slots, undefined);
}

/**
 * Offline benchmark entry point for a candidate adapter.
 *
 * `adapter` is required rather than optional: a benchmark that meant to measure
 * a candidate but silently measured the champion would report a pass-rate delta
 * of zero and look like an honest negative result. Making it mandatory turns
 * that mistake into a compile error.
 *
 * The champion side of a comparison calls `runPipeline` directly, so the
 * baseline being measured is the exact code path production uses — not a
 * near-copy of it with an empty adapter threaded through.
 */
export async function runPipelineForBenchmark(
  description: string,
  targetIosVersion: string | undefined,
  slots: ConfirmedSlots,
  adapter: AdapterBlock,
): Promise<PipelineResult> {
  return runPipelineInternal(description, targetIosVersion, slots, adapter);
}

async function runPipelineInternal(
  description: string,
  targetIosVersion: string | undefined,
  slots: ConfirmedSlots,
  adapter: AdapterBlock | undefined,
): Promise<PipelineResult> {
  // ── Stage 1 ──────────────────────────────────────────────────────────────
  // Confirmed answers are folded into the checklist itself, so every later
  // stage inherits them and the seal verifies them like any other requirement.
  const checklist = await extractChecklist(description, slots);

  // ── Stage 2 ──────────────────────────────────────────────────────────────
  const { schemas, failures: schemaFailures } = retrieveSchemas(checklist);

  const pipelineFindings: ValidationFinding[] = schemaFailures.map((f) => ({
    severity: "warning" as const,
    source: "pipeline" as ValidationFinding["source"],
    message: f.message,
    suggestion: `Check the identifier "${f.identifier}" or mark the checklist item externalDomain: true.`,
  }));

  // ── Stage 3 ──────────────────────────────────────────────────────────────
  const ir = await generateIR(checklist, schemas, targetIosVersion, slots, adapter);

  // ── Stage 4 ──────────────────────────────────────────────────────────────
  const irErrors = validateIR(ir, checklist, schemas, targetIosVersion);
  const hardIrErrors = irErrors.filter((e) => !e.advisory);
  const advisoryIrErrors = irErrors.filter((e) => e.advisory);

  for (const irErr of irErrors) {
    pipelineFindings.push({
      severity: irErr.advisory ? "warning" : "error",
      source: "pipeline" as ValidationFinding["source"],
      message: irErr.message,
      suggestion: irErr.suggestion,
    });
  }

  // ── Stage 5 ──────────────────────────────────────────────────────────────
  const plist = irToShortcut(ir, description.slice(0, 60));

  // ── Stage 6 ──────────────────────────────────────────────────────────────
  const validation = validateShortcut(plist, targetIosVersion);
  const seal = sealChecklist(checklist, plist, ir);
  const completion = checkCompletion(description, plist, validation);

  // A value the user explicitly supplied must appear in the result. If it does
  // not, the shortcut is not what they described, regardless of how valid it is.
  const unappliedSlots = verifySlotsApplied(plist, slots);
  for (const slot of unappliedSlots) {
    pipelineFindings.push({
      severity: "error",
      source: "pipeline" as ValidationFinding["source"],
      message: `**[Answer ignored]** You said ${slot.key} is "${slot.value}", but it does not appear anywhere in the generated shortcut.`,
      suggestion:
        "Regenerate, or mention this detail directly in the description so it cannot be dropped.",
    });
  }

  const allWarnings: ValidationFinding[] = [
    ...pipelineFindings,
    ...validation.findings,
    ...completion.blockingFindings,
  ];

  // ── Unified readiness: pipeline gates + completion gate ──────────────────
  // The shortcut is fully ready only when ALL of the following pass:
  //   1. No hard IR errors (grounding, structure)
  //   2. Checklist seal passed (every item has a matching plist action)
  //   3. No hard plist schema errors
  //   4. Every value the user supplied actually reached the plist
  //   5. Completion gate satisfied (no hollow placeholders, no unsupported caps)
  //
  // INVARIANT: id is present ⟺ completionStatus.satisfied === true.
  //
  // When the pipeline's own stages fail while the completion gate would otherwise
  // pass (e.g. grounding fails but the plist looks structurally valid), we
  // downgrade completionStatus to keep this invariant. The frontend's import
  // gating depends solely on completionStatus.satisfied — it does not need to
  // separately check checklistSatisfied.
  const pipelineGatesPassed =
    hardIrErrors.length === 0 &&
    seal.satisfied &&
    validation.hardSchemaErrors.length === 0 &&
    unappliedSlots.length === 0;

  const checklistSatisfied = pipelineGatesPassed && completion.satisfied;

  // Downgrade completion if our pipeline gates failed while completion passed.
  const finalCompletion: CompletionResult = checklistSatisfied
    ? completion
    : {
        ...completion,
        satisfied: false,
        // Keep status from the more-informative gate if it already failed.
        // Otherwise mark as "incomplete" to signal a pipeline-level issue.
        status: completion.satisfied ? ("incomplete" as const) : completion.status,
      };

  const id = checklistSatisfied ? storeShortcut(plist) : undefined;

  // Build actions metadata: exclude synthetic control-flow markers
  const SYNTHETIC_IDS = new Set([
    "is.workflow.actions.conditional.otherwise",
    "is.workflow.actions.conditional.end",
    "is.workflow.actions.repeat.count.end",
  ]);

  const actionsMetadata: ActionExplanation[] = plist.WFWorkflowActions.filter(
    (a) => !SYNTHETIC_IDS.has(a.WFWorkflowActionIdentifier),
  ).map((a, i) => {
    const entry = getActionByIdentifier(a.WFWorkflowActionIdentifier);
    const params = Object.entries(a.WFWorkflowActionParameters ?? {})
      .filter(([k]) => k !== "WFControlFlowMode")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    return {
      actionIndex: i,
      identifier: a.WFWorkflowActionIdentifier,
      displayName: entry?.displayName ?? a.WFWorkflowActionIdentifier,
      explanation: entry?.description ?? "Third-party or uncatalogued action",
      parameterSummary: params,
    };
  });

  let explanation = `Generated "${ir.goal || description.slice(0, 80)}"`;
  if (seal.unsatisfiedItems.length > 0) {
    explanation += ` — ${seal.unsatisfiedItems.length} requirement(s) could not be fully satisfied`;
  }

  const uncertainty = [
    ...(ir.unsatisfiedItems?.map((u) => `Could not satisfy "${u.itemId}": ${u.reason}`) ?? []),
    ...schemaFailures.map((f) => f.message),
    ...unappliedSlots.map(
      (s) => `Your answer for ${s.key} ("${s.value}") did not make it into the shortcut.`,
    ),
  ];

  return {
    shortcut: plist,
    actions: actionsMetadata,
    warnings: allWarnings,
    minimumIosVersion: validation.minimumIosVersion,
    explanation,
    uncertainty,
    alternatives: [],
    checklistSatisfied,
    checklist: checklist.items as IntentChecklistItem[],
    completionStatus: finalCompletion,
    hardIrErrors,
    advisoryIrErrors,
    ...(id !== undefined ? { id } : {}),
  };
}
