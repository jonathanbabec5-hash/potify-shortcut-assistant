/**
 * Which pipeline failures are principled refusals, and which are just failures.
 *
 * ## Why the distinction has to be explicit
 *
 * A must-refuse evaluation case asks "did the pipeline decline to build something
 * it had no basis for". The tempting shortcut is to score it on "no importable
 * shortcut came out", because a refusal certainly produces no output. But so does
 * a model that emitted structurally broken control flow, or steps no checklist
 * item justified. Scoring on absence of output alone would mark a case as a
 * successful refusal because generation *failed*, which measures the opposite of
 * the intended capability and would let a variant look better at refusing by
 * getting worse at generating.
 *
 * So refusal is defined by *why* nothing was produced, and only two of the seven
 * validation stages qualify:
 *
 *   - `grounding` — the action does not exist in the catalog. The capability the
 *     user asked for is not available, which is a legitimate "I can't do that".
 *   - `parameters` — a required parameter was never supplied and could not be
 *     bound. Asking rather than inventing a value is the correct answer.
 *
 * The other five (`variables`, `controlflow`, `checklist`, `platform`,
 * `invention`) all mean the model produced something and the something was wrong.
 * That is a generation defect. It must be scored as a failure even on a case whose
 * expected outcome is refusal, because the pipeline arrived there by accident.
 *
 * ## Where this leaves the governing invariant
 *
 * Untouched. Import is still offered only when the shortcut is genuinely complete;
 * this module classifies failures for measurement and grants nothing.
 */

import type { IRValidationError, IRValidationStage } from "./pipeline-types";

/**
 * Stages where a hard error means "declined for lack of a basis to build".
 *
 * Deliberately a narrow allow-list rather than a deny-list of the others: a
 * validation stage added later is treated as a generation defect until someone
 * decides otherwise, which is the safe default. The opposite construction would
 * silently widen what counts as a good refusal every time the taxonomy grows.
 */
const REFUSAL_STAGES: ReadonlySet<IRValidationStage> = new Set<IRValidationStage>([
  "grounding",
  "parameters",
]);

export interface RefusalClassification {
  /** True only when at least one hard error is refusal-class. */
  refused: boolean;
  /** The refusal-class stages seen, sorted and joined. Empty when not refused. */
  reason: string;
  /**
   * Hard errors that are NOT refusal-class.
   *
   * Kept separate so a caller can tell "declined cleanly" from "declined *and*
   * produced garbage on the way". The second is still a defect worth surfacing.
   */
  otherHardStages: string[];
}

/**
 * Classifies the hard (non-advisory) errors from a pipeline run.
 *
 * Takes the error list rather than the whole result so it cannot be tempted to
 * consult the presence of an id — importability is a separate question, checked
 * separately by the harness.
 */
export function classifyRefusal(
  hardIrErrors: readonly IRValidationError[],
): RefusalClassification {
  const refusalStages = new Set<string>();
  const otherStages = new Set<string>();

  for (const error of hardIrErrors) {
    if (REFUSAL_STAGES.has(error.stage)) refusalStages.add(error.stage);
    else otherStages.add(error.stage);
  }

  return {
    refused: refusalStages.size > 0,
    reason: [...refusalStages].sort().join("+"),
    otherHardStages: [...otherStages].sort(),
  };
}

/** The refusal-class stage names, for diagnostics and tests. */
export function refusalStages(): readonly IRValidationStage[] {
  return [...REFUSAL_STAGES].sort();
}
