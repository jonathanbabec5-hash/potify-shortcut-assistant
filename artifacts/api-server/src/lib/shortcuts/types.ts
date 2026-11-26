import type { ShortcutPlist, ShortcutsActionCatalogEntry } from "./catalog";
import type { ValidationFinding } from "./validation";
import type { Plan, PlanStep } from "./planner";
import type { CompletionResult } from "./completion";
import type { IntentChecklistItem } from "./pipeline-types";

export type { CompletionResult };
export type { IntentChecklistItem };

export interface ActionExplanation {
  actionIndex: number;
  identifier: string;
  displayName: string;
  explanation: string;
  parameterSummary: string;
}

export interface ActionSuggestion {
  identifier: string;
  displayName: string;
  rationale: string;
  parameters: Record<string, unknown>;
}

export interface RepairChange {
  actionIndex: number;
  changeType: "modified" | "removed" | "added";
  description: string;
}

export interface GenerateShortcutResponse {
  /**
   * Identifies this run. Required so the client can attach later signals
   * (import confirmed, ran on device, user edits) to the right example.
   */
  runId: string;
  /**
   * File store ID — present only when completionStatus.satisfied === true.
   *
   * INVARIANT: id is present ⟺ completionStatus.satisfied === true.
   *
   * `completionStatus.satisfied` reflects the full pipeline pass: all six
   * stages must succeed (IR grounding, checklist seal, plist validation, and
   * the completion gate). It is NOT sufficient to check `checklistSatisfied`
   * separately — always gate import availability on `completionStatus.satisfied`.
   */
  id?: string;
  shortcut: ShortcutPlist;
  actions: ActionExplanation[];
  warnings: ValidationFinding[];
  minimumIosVersion: string;
  explanation: string;
  uncertainty: string[];
  alternatives: Array<{ label: string; description: string }>;
  /** Always present. Import is only valid when completionStatus.satisfied === true. */
  completionStatus: CompletionResult;
  /**
   * True when the six-stage pipeline fully satisfied the locked checklist
   * and the plist passed all validation gates. Always false when completionStatus.satisfied is false.
   */
  checklistSatisfied: boolean;
  /**
   * The locked intent checklist extracted in Stage 1.
   * Each item describes one requirement the pipeline attempted to satisfy.
   */
  checklist: IntentChecklistItem[];
}

export interface ValidateShortcutResponse {
  findings: ValidationFinding[];
  minimumIosVersion: string;
  requiredPermissions: string[];
  requiredDeviceFeatures: string[];
  dataFlowSummary: {
    producedVariables: number;
    consumedVariables: number;
    unboundInputs: number;
    unreachableSteps: number[];
  };
  executionTrace: Array<{ step: number; action: string; status: "ok" | "warn" | "fail"; notes: string[] }>;
}

export interface ExplainShortcutResponse {
  steps: ActionExplanation[];
  summary: string;
  dataFlow: string;
  compatibility: string;
}

export interface RepairShortcutResponse {
  shortcut: ShortcutPlist;
  changelog: RepairChange[];
  unresolved: string[];
  alternatives: Array<{ label: string; description: string }>;
}

export interface SuggestNextActionsResponse {
  suggestions: ActionSuggestion[];
}

export interface ShortcutsActionsCatalog {
  version: string;
  targetIosVersion: string;
  actions: ShortcutsActionCatalogEntry[];
}

export interface StoreShortcutFileResponse {
  id: string;
}

export interface ClarifyShortcutResponse {
  needed: boolean;
  questions: Array<{
    slotKey: string;
    displayName: string;
    description: string;
    type: string;
    enumeration?: string[];
  }>;
}

export interface PlanShortcutResponse extends Plan {}

export interface DiagnoseShortcutResponse {
  trace: Array<{ step: number; action: string; status: "ok" | "warn" | "fail"; notes: string[] }>;
  producedVariables: number;
  consumedVariables: number;
  unboundInputs: number;
  unreachableSteps: number[];
  requiredDeviceFeatures: string[];
}

export { Plan, PlanStep };
