import {
  type ShortcutAction,
  type ShortcutPlist,
  type ShortcutsActionCatalogEntry,
  getActionByIdentifier,
  clientVersionToIosString,
} from "./catalog";
import { analyzeDataFlow, traceExecution } from "./dataflow";
import { analyzeCompatibility } from "./compatibility";

export interface ValidationFinding {
  severity: "error" | "warning" | "info";
  /**
   * "schema"     — deterministic structural check (catalog, required params, control-flow)
   * "ai"         — semantic/heuristic finding from the LLM reviewer
   * "completion" — completion-gate finding (hollow placeholder, saturation, unsatisfied requirement)
   * "pipeline"   — six-stage pipeline finding (IR grounding, checklist coverage, invented logic)
   */
  source: "schema" | "ai" | "completion" | "pipeline";
  actionIndex?: number;
  /** Populated by the completion gate for Comment-substitution findings. */
  actionIdentifier?: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  findings: ValidationFinding[];
  /**
   * Subset of `findings` that are definitively blocking schema failures:
   *   - Shortcut has zero actions
   *   - An action is missing its WFWorkflowActionIdentifier
   *   - An action is missing a required parameter
   *
   * Does NOT include heuristic or advisory findings such as:
   *   - Unknown action identifiers (the action may be valid on newer iOS)
   *   - Unreachable-step warnings (heuristic, now "warning" severity)
   *   - Control-flow structure errors (unclosed groups, orphaned ends)
   *   - Compatibility warnings
   *
   * Used by the 422 gate in the generate route so it can gate on structural
   * correctness without relying on fragile message-text substring matching.
   */
  hardSchemaErrors: ValidationFinding[];
  minimumClientVersion: number;
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

export function validateShortcut(
  shortcut: ShortcutPlist,
  targetIosVersion?: string,
): ValidationResult {
  const findings: ValidationFinding[] = [];

  /**
   * Hard schema errors: a typed subset of `findings` for the 422 gate.
   * Only populated for definitively broken structure:
   *   - Shortcut has zero actions
   *   - An action is missing its WFWorkflowActionIdentifier
   *   - An action is missing a required parameter
   * Control-flow errors, heuristic warnings, and compatibility notes are
   * excluded so the gate never fires on false positives.
   */
  const hardSchemaErrors: ValidationFinding[] = [];

  /** Record a finding AND mark it as a hard schema error. */
  function pushHard(f: ValidationFinding): void {
    findings.push(f);
    hardSchemaErrors.push(f);
  }

  const actions = shortcut.WFWorkflowActions ?? [];

  if (actions.length === 0) {
    pushHard({
      severity: "error",
      source: "schema",
      message: "Shortcut has no actions. Add at least one action to make it useful.",
      suggestion: "Add a starting action such as Text, Ask for Input, or Get Current Location.",
    });
  }

  let minimumClientVersion = 700;
  const requiredPermissions = new Set<string>();
  const openGroups = new Map<string, { start: number; type: string }>();
  const groupEndMap = new Map<string, number>();

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const identifier = action.WFWorkflowActionIdentifier;

    if (!identifier) {
      pushHard({
        severity: "error",
        source: "schema",
        actionIndex: i,
        message: `Action at position ${i + 1} is missing its identifier (WFWorkflowActionIdentifier).`,
        suggestion: "Provide a valid Shortcuts action identifier.",
      });
      continue;
    }

    const catalogEntry = getActionByIdentifier(identifier);
    if (!catalogEntry) {
      // Unknown identifiers are advisory warnings, not hard errors.
      // The action may be a third-party app action or a new iOS action not yet in the catalog.
      findings.push({
        severity: "warning",
        source: "schema",
        actionIndex: i,
        message: `Action identifier "${identifier}" is not in the known catalog. It may be a third-party action, a new iOS action, or a typo.`,
        suggestion: "Check the action identifier or use the action catalog to pick a known action.",
      });
      continue;
    }

    minimumClientVersion = Math.max(minimumClientVersion, catalogEntry.minimumClientVersion);
    for (const permission of catalogEntry.permissions) {
      requiredPermissions.add(permission);
    }

    validateParameters(i, catalogEntry, action, findings, hardSchemaErrors);
    validateControlFlow(i, catalogEntry, action, openGroups, groupEndMap, findings);
    validateDeviceNotes(i, catalogEntry, findings);
  }

  // Check for unclosed groups
  for (const [id, { start, type }] of openGroups.entries()) {
    if (!groupEndMap.has(id)) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: start,
        message: `A "${type}" block starting at action ${start + 1} has no matching End action.`,
        suggestion: `Add the matching End ${type} action after the block.`,
      });
    }
  }

  // Check for orphaned end groups
  for (const [id, endIndex] of groupEndMap.entries()) {
    if (!openGroups.has(id)) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: endIndex,
        message: `An End action at position ${endIndex + 1} has no matching opening action.`,
        suggestion: "Remove the orphan End action or add a matching opening action.",
      });
    }
  }

  // Compatibility
  const compatibility = analyzeCompatibility(shortcut, targetIosVersion);
  for (const warning of compatibility.warnings) {
    findings.push({
      severity: "warning",
      source: "schema",
      actionIndex: warning.actionIndex,
      message: warning.message,
      suggestion: warning.suggestion,
    });
  }
  for (const deprecated of compatibility.deprecatedActions) {
    findings.push({
      severity: "warning",
      source: "schema",
      actionIndex: deprecated.actionIndex,
      message: `Action "${deprecated.identifier}" is deprecated${deprecated.reason ? `: ${deprecated.reason}` : ""}.`,
      suggestion: "Use the recommended alternative identifier if available.",
    });
  }

  // Data flow analysis
  const dataFlow = analyzeDataFlow(shortcut);
  for (const unbound of dataFlow.unboundInputs) {
    findings.push({
      severity: "warning",
      source: "schema",
      actionIndex: unbound.step,
      message: `${unbound.action}: ${unbound.reason}`,
      suggestion: "Bind the input to a literal value or a previous action's output.",
    });
  }
  for (const unreachable of dataFlow.unreachableSteps) {
    findings.push({
      // "warning" not "error": unreachable-step detection is a heuristic based on
      // GroupingIdentifier analysis. It is accurate for genuinely unclosed groups but
      // it is NOT a definitive schema rule and must not block the 422 gate.
      severity: "warning",
      source: "schema",
      actionIndex: unreachable,
      message: `Action at position ${unreachable + 1} may be unreachable due to an unclosed control flow block.`,
      suggestion: "Check that every If / Repeat / Choose from Menu block has a matching End action.",
    });
  }

  const executionTrace = traceExecution(shortcut);
  for (const trace of executionTrace) {
    if (trace.status === "fail") {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: trace.step,
        message: `Execution trace: ${trace.action} — ${trace.notes.join("; ")}`,
      });
    } else if (trace.status === "warn" && !findings.some((f) => f.actionIndex === trace.step && f.source === "schema")) {
      findings.push({
        severity: "warning",
        source: "schema",
        actionIndex: trace.step,
        message: `Execution trace: ${trace.action} — ${trace.notes.join("; ")}`,
      });
    }
  }

  return {
    findings,
    hardSchemaErrors,
    minimumClientVersion,
    minimumIosVersion: clientVersionToIosString(minimumClientVersion),
    requiredPermissions: Array.from(requiredPermissions),
    requiredDeviceFeatures: compatibility.requiredDeviceFeatures,
    dataFlowSummary: {
      producedVariables: dataFlow.producedVariables.length,
      consumedVariables: dataFlow.consumedVariables.length,
      unboundInputs: dataFlow.unboundInputs.length,
      unreachableSteps: dataFlow.unreachableSteps,
    },
    executionTrace,
  };
}

function validateParameters(
  index: number,
  catalogEntry: ShortcutsActionCatalogEntry,
  action: ShortcutAction,
  findings: ValidationFinding[],
  hardSchemaErrors: ValidationFinding[],
): void {
  const params = action.WFWorkflowActionParameters ?? {};
  for (const requiredParam of catalogEntry.parameters.required) {
    if (!(requiredParam.key in params)) {
      const f: ValidationFinding = {
        severity: "error",
        source: "schema",
        actionIndex: index,
        message: `Action "${catalogEntry.displayName}" is missing required parameter "${requiredParam.displayName}" (${requiredParam.key}).`,
        suggestion: `Set the ${requiredParam.displayName} parameter in the action's WFWorkflowActionParameters.`,
      };
      findings.push(f);
      // Missing required parameter is a definitively blocking hard error.
      hardSchemaErrors.push(f);
    } else {
      const typeFinding = checkParameterType(
        index,
        catalogEntry.displayName,
        requiredParam.key,
        requiredParam.displayName,
        requiredParam.type,
        params[requiredParam.key],
      );
      if (typeFinding) findings.push(typeFinding);
    }
  }
}

function validateControlFlow(
  index: number,
  catalogEntry: ShortcutsActionCatalogEntry,
  action: ShortcutAction,
  openGroups: Map<string, { start: number; type: string }>,
  groupEndMap: Map<string, number>,
  findings: ValidationFinding[],
): void {
  if (!catalogEntry.controlFlow?.isGroup) return;

  const groupId = action.GroupingIdentifier;

  if (catalogEntry.controlFlow.beginsGroup) {
    if (!groupId) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: index,
        message: `Control flow action "${catalogEntry.displayName}" at position ${index + 1} is missing a GroupingIdentifier.`,
        suggestion: "Assign a unique GroupingIdentifier to this action.",
      });
      return;
    }
    if (openGroups.has(groupId)) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: index,
        message: `Duplicate GroupingIdentifier "${groupId}" at position ${index + 1}.`,
        suggestion: "Use a unique GroupingIdentifier for each control flow block.",
      });
      return;
    }
    openGroups.set(groupId, { start: index, type: catalogEntry.controlFlow.groupType ?? "block" });
  } else if (catalogEntry.controlFlow.endsGroup) {
    if (!groupId) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: index,
        message: `End control flow action at position ${index + 1} is missing a GroupingIdentifier.`,
        suggestion: "Set the GroupingIdentifier to match the opening action.",
      });
      return;
    }
    if (groupEndMap.has(groupId)) {
      findings.push({
        severity: "error",
        source: "schema",
        actionIndex: index,
        message: `Multiple End actions found for GroupingIdentifier "${groupId}".`,
        suggestion: "Each control flow block should have exactly one End action.",
      });
      return;
    }
    groupEndMap.set(groupId, index);
    if (openGroups.has(groupId)) {
      const { type } = openGroups.get(groupId)!;
      if (type !== catalogEntry.controlFlow.groupType && catalogEntry.controlFlow.groupType !== "end") {
        // fine, end is generic
      }
    }
  }
}

function validateDeviceNotes(
  index: number,
  catalogEntry: ShortcutsActionCatalogEntry,
  findings: ValidationFinding[],
): void {
  for (const knownIssue of catalogEntry.knownIssues) {
    findings.push({
      severity: "info",
      source: "schema",
      actionIndex: index,
      message: `Note for "${catalogEntry.displayName}": ${knownIssue}`,
    });
  }
}

function checkParameterType(
  actionIndex: number,
  displayName: string,
  key: string,
  paramDisplayName: string,
  expectedType: string,
  value: unknown,
): ValidationFinding | undefined {
  if (value === undefined || value === null) return undefined;

  const jsType = typeof value;
  if (expectedType === "string" && jsType !== "string") {
    return {
      severity: "warning",
      source: "schema",
      actionIndex,
      message: `Parameter "${paramDisplayName}" in "${displayName}" should be a string, but got ${jsType}.`,
      suggestion: "Convert the value to a string or use a Text action as input.",
    };
  }
  if (expectedType === "number" && jsType !== "number") {
    return {
      severity: "warning",
      source: "schema",
      actionIndex,
      message: `Parameter "${paramDisplayName}" in "${displayName}" should be a number, but got ${jsType}.`,
      suggestion: "Provide a numeric value or use a Number action as input.",
    };
  }
  if (expectedType === "boolean" && jsType !== "boolean") {
    return {
      severity: "warning",
      source: "schema",
      actionIndex,
      message: `Parameter "${paramDisplayName}" in "${displayName}" should be a boolean, but got ${jsType}.`,
      suggestion: "Provide a true/false value.",
    };
  }
  if (expectedType === "array" && !Array.isArray(value)) {
    return {
      severity: "warning",
      source: "schema",
      actionIndex,
      message: `Parameter "${paramDisplayName}" in "${displayName}" should be an array, but got ${jsType}.`,
      suggestion: "Provide a list of values.",
    };
  }
  return undefined;
}

export function diffShortcuts(
  before: ShortcutPlist,
  after: ShortcutPlist,
): Array<{
    actionIndex: number;
    changeType: "modified" | "removed" | "added";
    description: string;
}> {
  const changes: Array<{
    actionIndex: number;
    changeType: "modified" | "removed" | "added";
    description: string;
  }> = [];

  const beforeActions = before.WFWorkflowActions ?? [];
  const afterActions = after.WFWorkflowActions ?? [];
  const maxLen = Math.max(beforeActions.length, afterActions.length);

  for (let i = 0; i < maxLen; i++) {
    const beforeAction = beforeActions[i];
    const afterAction = afterActions[i];

    if (!beforeAction && afterAction) {
      changes.push({
        actionIndex: i,
        changeType: "added",
        description: `Added action ${i + 1}: ${afterAction.WFWorkflowActionIdentifier}`,
      });
    } else if (beforeAction && !afterAction) {
      changes.push({
        actionIndex: i,
        changeType: "removed",
        description: `Removed action ${i + 1}: ${beforeAction.WFWorkflowActionIdentifier}`,
      });
    } else if (
      beforeAction &&
      afterAction &&
      JSON.stringify(beforeAction) !== JSON.stringify(afterAction)
    ) {
      changes.push({
        actionIndex: i,
        changeType: "modified",
        description: `Modified action ${i + 1}: ${beforeAction.WFWorkflowActionIdentifier}`,
      });
    }
  }

  return changes;
}
