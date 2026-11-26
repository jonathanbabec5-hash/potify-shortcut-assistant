import {
  type ShortcutAction,
  type ShortcutPlist,
  type ShortcutsActionCatalogEntry,
  getActionByIdentifier,
} from "./catalog";

export interface DataFlowEdge {
  fromStep: number;
  fromAction: string;
  fromOutput: string;
  toStep: number;
  toAction: string;
  toInput: string;
  confidence: "explicit" | "inferred" | "weak";
}

export interface DataFlowAnalysis {
  edges: DataFlowEdge[];
  unreachableSteps: number[];
  unboundInputs: Array<{ step: number; action: string; input: string; reason: string }>;
  producedVariables: Array<{ step: number; name: string; type: string }>;
  consumedVariables: Array<{ step: number; name: string; type: string }>;
}

export function analyzeDataFlow(shortcut: ShortcutPlist): DataFlowAnalysis {
  const actions = shortcut.WFWorkflowActions ?? [];
  const edges: DataFlowEdge[] = [];
  const producedVariables: DataFlowAnalysis["producedVariables"] = [];
  const consumedVariables: DataFlowAnalysis["consumedVariables"] = [];
  const unboundInputs: DataFlowAnalysis["unboundInputs"] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const catalogEntry = getActionByIdentifier(action.WFWorkflowActionIdentifier);
    if (!catalogEntry) continue;

    for (const output of catalogEntry.outputs ?? []) {
      producedVariables.push({ step: i, name: output.key, type: output.type });
    }

    for (const input of catalogEntry.inputs ?? []) {
      consumedVariables.push({ step: i, name: input.key, type: input.type });

      const paramValue = action.WFWorkflowActionParameters?.[input.key];
      if (paramValue === undefined || paramValue === null) {
        unboundInputs.push({
          step: i,
          action: catalogEntry.displayName,
          input: input.displayName,
          reason: "Required variable input is not bound.",
        });
      }
    }
  }

  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const fromAction = actions[i];
      const toAction = actions[j];
      const fromEntry = getActionByIdentifier(fromAction.WFWorkflowActionIdentifier);
      const toEntry = getActionByIdentifier(toAction.WFWorkflowActionIdentifier);
      if (!fromEntry || !toEntry) continue;

      for (const output of fromEntry.outputs ?? []) {
        for (const input of toEntry.inputs ?? []) {
          if (output.type === input.type || typesCompatible(output.type, input.type)) {
            edges.push({
              fromStep: i,
              fromAction: fromEntry.displayName,
              fromOutput: output.key,
              toStep: j,
              toAction: toEntry.displayName,
              toInput: input.key,
              confidence: output.type === input.type ? "explicit" : "inferred",
            });
          }
        }
      }
    }
  }

  const unreachableSteps = findUnreachableSteps(actions);

  return { edges, unreachableSteps, unboundInputs, producedVariables, consumedVariables };
}

function typesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const containerTypes = ["dictionary", "array", "string", "number", "boolean"];
  if (containerTypes.includes(a) && containerTypes.includes(b)) return true;
  return false;
}

/**
 * Detects genuinely unreachable steps caused by unclosed control-flow groups.
 *
 * Correct algorithm:
 *  1. Walk actions once, tracking openers by GroupingIdentifier.
 *  2. When a group-ender is seen, close its matching opener (remove from open set).
 *  3. After the walk, any opener still open has no matching End — the action
 *     immediately after the opener (start + 1) is unreachable.
 *  4. Actions INSIDE a closed group (including Otherwise branches) are NOT unreachable;
 *     they are valid else-branch or repeat-body content.
 *
 * Previously (bug): the code iterated the body of every closed conditional group
 * and marked any action whose GroupingIdentifier matched the group ID as unreachable.
 * In a correct If / Otherwise / End If sequence, the Otherwise action and all
 * else-branch actions legitimately share the GroupingIdentifier — marking them
 * unreachable was a false positive.
 */
function findUnreachableSteps(actions: ShortcutAction[]): number[] {
  const unreachable: number[] = [];
  // Map from GroupingIdentifier → { start index, type }
  const openGroups = new Map<string, { start: number; type: string }>();

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const entry = getActionByIdentifier(action.WFWorkflowActionIdentifier);
    if (!entry?.controlFlow?.isGroup) continue;

    if (entry.controlFlow.beginsGroup) {
      const id = action.GroupingIdentifier ?? `group-${i}`;
      openGroups.set(id, { start: i, type: entry.controlFlow.groupType ?? "unknown" });
    } else if (entry.controlFlow.endsGroup && action.GroupingIdentifier) {
      // Close the group — it is properly formed and contains no unreachable steps.
      openGroups.delete(action.GroupingIdentifier);
    }
    // Mid-block markers (Otherwise, Menu Item) are intentionally ignored here:
    // they share the GroupingIdentifier with their parent opener and are valid.
  }

  // Any opener still in the map has no matching End — the step after the opener is unreachable.
  for (const [, { start }] of openGroups.entries()) {
    const afterOpener = start + 1;
    if (afterOpener < actions.length) {
      unreachable.push(afterOpener);
    }
  }

  return unreachable;
}

export function traceExecution(shortcut: ShortcutPlist): Array<{ step: number; action: string; status: "ok" | "warn" | "fail"; notes: string[] }> {
  const actions = shortcut.WFWorkflowActions ?? [];
  const trace: Array<{ step: number; action: string; status: "ok" | "warn" | "fail"; notes: string[] }> = [];
  const availableVars = new Set<string>();

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const entry = getActionByIdentifier(action.WFWorkflowActionIdentifier);
    const notes: string[] = [];
    let status: "ok" | "warn" | "fail" = "ok";

    if (!entry) {
      status = "warn";
      notes.push("Unknown action identifier; runtime behavior is uncertain.");
    } else {
      for (const required of entry.parameters.required) {
        if (action.WFWorkflowActionParameters?.[required.key] === undefined) {
          status = "fail";
          notes.push(`Missing required parameter: ${required.displayName}`);
        }
      }
      for (const input of entry.inputs ?? []) {
        if (action.WFWorkflowActionParameters?.[input.key] === undefined && !availableVars.has(input.key)) {
          status = "warn";
          notes.push(`Input "${input.displayName}" may not be available at this step.`);
        }
      }
      for (const output of entry.outputs ?? []) {
        availableVars.add(output.key);
      }
    }

    trace.push({ step: i, action: entry?.displayName ?? action.WFWorkflowActionIdentifier, status, notes });
  }

  return trace;
}
