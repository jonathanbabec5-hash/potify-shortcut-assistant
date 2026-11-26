/**
 * Type definitions for the six-stage reasoning pipeline.
 * Kept separate from planner.ts so pipeline.ts has no circular deps.
 */

import type { ShortcutsActionCatalogEntry, ShortcutPlist } from "./catalog";
import type { ValidationFinding } from "./validation";
import type { CompletionResult } from "./completion";
import type { ActionExplanation } from "./types";

// ── Checklist ─────────────────────────────────────────────────────────────────

export interface IntentChecklistItem {
  /** Short stable identifier used in assertion messages and satisfies arrays. */
  id: string;
  /**
   * "condition"  — the shortcut must test this condition at runtime.
   * "action"     — the shortcut must perform this real (non-Comment) action.
   * "constraint" — a platform or permission constraint the shortcut must respect.
   */
  type: "condition" | "action" | "constraint";
  /** Human-readable description of this requirement. */
  description: string;
  /**
   * Catalog identifiers (or capability patterns for uncatalogued domains) that
   * would satisfy this item.  Examples:
   *   - "is.workflow.actions.getdistance"
   *   - "homekit.setstate"     ← not in catalog; Stage 2 marks as "external"
   */
  requiredActions: string[];
  // condition-specific fields
  operand?: string;
  operator?: string;
  threshold?: unknown;
  /** True when the LLM could not resolve an ambiguous requirement. */
  needsClarification?: boolean;
  /**
   * True when requiredActions contains identifiers from a known external domain
   * (HomeKit, NFC, third-party apps) that are not in the built-in catalog.
   * Stage 2 does NOT hard-fail on these; Stage 3 is asked to use the best
   * available identifier it knows about.
   */
  externalDomain?: boolean;
}

export interface IntentChecklist {
  items: IntentChecklistItem[];
  /** SHA-256 hex of JSON.stringify(items). Set at lock time. */
  hash: string;
  /** Unix timestamp (ms) when the checklist was locked. */
  lockedAt: number;
}

// ── IR types ──────────────────────────────────────────────────────────────────

export interface IRParameterBinding {
  key: string;
  /** Data type of the value (e.g. "string", "number", "location", "contact"). */
  valueType: string;
  value: unknown | null;
  source: "literal" | "variable" | "user-input";
  /** Resolves to an IRVariable when source === "variable". */
  variableId?: string;
}

export interface IRStep {
  id: string;
  /**
   * Must exist in RetrievedSchemas (or be an "external" domain action).
   * Cannot be a Comment action (is.workflow.actions.comment).
   */
  actionIdentifier: string;
  parameterBindings: IRParameterBinding[];
  /**
   * ID of the IRVariable this step produces.
   * Must be declared in WorkflowIR.variables.
   */
  producesVariable?: string;
  /**
   * Which checklist item justifies this step's existence.
   * A step without a justifiedByItemId is potentially "invented" and will be
   * flagged by Stage 4 check 7.
   */
  justifiedByItemId?: string;
}

export interface IRVariable {
  id: string;
  /** Semantic type, e.g. "distance-km", "time", "homekit-state". */
  type: string;
  /** ID of the IRStep that produces this variable. */
  producedByStep: string;
}

export interface IRBlock {
  type: "if" | "repeat" | "choose";
  /** The IRStep that evaluates the condition (becomes the If opener in plist). */
  conditionStepId: string;
  /** IRStep ids in the then-branch (condition step of a nestedBlock is included here). */
  thenSteps: string[];
  /** IRStep ids in the else-branch. Empty array means "no else / do nothing". */
  elseSteps: string[];
  /** Nested blocks whose condition step appears inside this block's then-branch. */
  nestedBlocks: IRBlock[];
  /** Which IntentChecklistItem.id this block satisfies. */
  checklistItemId?: string;
}

export interface WorkflowIR {
  goal: string;
  /**
   * All steps in execution order (flat list).
   * Control-flow opener/closer actions (conditional, conditional.end, etc.)
   * are NOT listed here — they are inferred by irToShortcut from controlFlow.
   */
  steps: IRStep[];
  variables: IRVariable[];
  /**
   * Top-level control-flow blocks.
   * Each block's conditionStepId must appear in steps.
   */
  controlFlow: IRBlock[];
  /** IntentChecklistItem ids that this IR claims to satisfy. */
  satisfies: string[];
  /** Items the LLM could not satisfy, with explanations. */
  unsatisfiedItems?: Array<{ itemId: string; reason: string }>;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type IRValidationStage =
  | "grounding"    // check 1: action identifier in RetrievedSchemas
  | "parameters"   // check 2: required params bound, keys valid, types match
  | "variables"    // check 3: variable references resolve, order correct
  | "controlflow"  // check 4: block structure valid
  | "checklist"    // check 5: all items covered
  | "platform"     // check 6: version and permission constraints
  | "invention";   // check 7: no steps without checklist justification

export interface IRValidationError {
  stage: IRValidationStage;
  checklistItemId?: string;
  stepId?: string;
  message: string;
  suggestion: string;
  /**
   * If true, this error is advisory (surface to user but don't hard-fail).
   * Hard errors (advisory === false) block the pipeline.
   */
  advisory: boolean;
}

// ── Schema map ────────────────────────────────────────────────────────────────

/**
 * Maps a requiredActions identifier to:
 *   - ShortcutsActionCatalogEntry: fully known, schema available
 *   - "external": known third-party / uncatalogued domain (HomeKit, NFC, etc.)
 *                 The sealChecklist will still do per-item pattern matching.
 *
 * Identifiers that are NOT in the catalog and do NOT match a known external
 * domain are intentionally omitted from the map. Stage 4 grounding check
 * uses `!schemas.has(identifier)` to detect them and emits a hard error.
 */
export type RetrievedSchemas = Map<string, ShortcutsActionCatalogEntry | "external">;

// ── Pipeline result ───────────────────────────────────────────────────────────

export interface PipelineFailureDetail {
  unsatisfiedItems: IntentChecklistItem[];
  irErrors: IRValidationError[];
  suggestion: string;
}

export interface PipelineResult {
  shortcut: ShortcutPlist;
  actions: ActionExplanation[];
  warnings: ValidationFinding[];
  minimumIosVersion: string;
  explanation: string;
  uncertainty: string[];
  alternatives: Array<{ label: string; description: string }>;
  /** True when the full pipeline passed and the shortcut is ready to import. */
  checklistSatisfied: boolean;
  /** The locked checklist from Stage 1. Always present after Stage 1 succeeds. */
  checklist: IntentChecklistItem[];
  completionStatus: CompletionResult;
  /**
   * Hard (non-advisory) IR errors from Stage 4, keyed by stage.
   * The route uses these for structured 422 detection without relying on message text.
   */
  hardIrErrors: IRValidationError[];
  /**
   * Advisory (non-blocking) IR errors from Stage 4. Surfaced to the user as
   * warnings and counted as a quality signal — a run that is technically
   * importable but carries many advisories is worse than one that carries none.
   */
  advisoryIrErrors: IRValidationError[];
  /** File store ID, present only when checklistSatisfied && completionStatus.satisfied. */
  id?: string;
}
