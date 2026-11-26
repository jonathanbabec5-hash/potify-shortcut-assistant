/**
 * Reliable outcome measurement.
 *
 * A `RunOutcome` is the compact, provenance-carrying record of what one
 * generation attempt actually did. It is the unit that later stages depend on:
 * benchmark comparison, failure clustering, active-learning prioritisation, and
 * the champion-vs-challenger gate all read outcomes, not raw transcripts.
 *
 * Two properties are load-bearing:
 *
 *  1. **It contains no user text.** Only counts, enumerated states, and PII
 *     *class* labels. That is what makes `outcomes-only` a meaningful consent
 *     tier — a user can allow quality measurement without allowing their words
 *     to be stored.
 *  2. **It carries provenance.** Catalog version, model, prompt hash, validator
 *     version, pipeline version. Without these, two outcomes measured months
 *     apart are not comparable and any "improvement" is unfalsifiable.
 *
 * Computing an outcome is not collecting one. `measureRun` is pure and may run
 * unconditionally; RETAINING the result requires `outcomes-only` consent.
 */

import type { IRValidationStage, PipelineResult } from "../shortcuts/pipeline-types";
import { UNMETERED_COST, type CostSummary } from "./cost";
import type { PiiClass } from "./privacy";
import { PIPELINE_VERSION, VALIDATOR_VERSION } from "./governance";

// ── Provenance ────────────────────────────────────────────────────────────────

export interface RunProvenance {
  catalogVersion: string;
  catalogHash: string;
  modelId: string;
  systemPromptHash: string;
  validatorVersion: string;
  pipelineVersion: string;
}

export function provenanceFrom(input: {
  catalogVersion: string;
  catalogHash: string;
  modelId: string;
  systemPromptHash: string;
}): RunProvenance {
  return {
    ...input,
    validatorVersion: VALIDATOR_VERSION,
    pipelineVersion: PIPELINE_VERSION,
  };
}

// ── Outcome ───────────────────────────────────────────────────────────────────

/**
 * Terminal state of a run.
 *
 * `unverified` is deliberate and important: it means the pipeline returned
 * something with no completion status attached. It is NOT a success. The UI
 * must not render it as one, and measurement must not count it as one.
 */
export type RunOutcomeKind =
  | "ready"
  | "incomplete"
  | "unsupported"
  | "validation-failed"
  | "unverified"
  | "cost-exceeded"
  | "error";

export type RunErrorKind =
  | "cost-ceiling"
  | "ir-validation"
  | "provider"
  | "internal";

/**
 * Which kind of run produced this measurement. Repair runs are measured with
 * the same governed fields as generation runs but must never be counted as
 * generations — a repair that resolves everything is not evidence that the
 * generator produced a working shortcut first time.
 */
export type RunKind = "generate" | "repair";

export interface RunOutcome {
  runId: string;
  kind: RunKind;
  outcome: RunOutcomeKind;
  /** True only when the user was actually offered an import. */
  importOffered: boolean;

  // ── deterministic quality signals ──
  executableActionCount: number;
  checklistItemCount: number;
  unsatisfiedItemCount: number;
  /** Distinct Stage-4 stages that produced hard errors — the clustering key. */
  hardErrorStages: IRValidationStage[];
  advisoryErrorCount: number;
  warningCount: number;
  uncertaintyCount: number;

  // ── shape, not content ──
  descriptionLength: number;
  /** Which PII classes were present. Never the values. */
  redactedClasses: PiiClass[];
  containedSecret: boolean;

  // ── efficiency ──
  durationMs: number;
  cost: CostSummary;

  // ── comparability ──
  provenance: RunProvenance;
  errorKind?: RunErrorKind;
  measuredAt: number;
}

export interface MeasureRunInput {
  runId: string;
  startedAt: number;
  finishedAt: number;
  /** Present when the pipeline returned; absent when it threw. */
  result?: PipelineResult | null;
  errorKind?: RunErrorKind | null;
  cost: CostSummary;
  provenance: RunProvenance;
  descriptionLength: number;
  redactedClasses?: PiiClass[];
  containedSecret?: boolean;
}

/**
 * Pure. Derives the outcome from what the pipeline returned — never from a
 * caller-supplied verdict, so a buggy route cannot record a failure as a
 * success.
 */
export function measureRun(input: MeasureRunInput): RunOutcome {
  const r = input.result ?? null;

  let outcome: RunOutcomeKind;
  if (input.errorKind === "cost-ceiling") {
    outcome = "cost-exceeded";
  } else if (!r) {
    outcome = "error";
  } else if (!r.completionStatus) {
    // No completion status attached — unverifiable, therefore not a success.
    outcome = "unverified";
  } else {
    outcome = r.completionStatus.status as RunOutcomeKind;
  }

  // Import is offered only on a satisfied completion status WITH a stored file.
  const importOffered = Boolean(
    r && r.completionStatus?.satisfied === true && r.checklistSatisfied && r.id,
  );

  const hardErrorStages = r
    ? [...new Set(r.hardIrErrors.map((e) => e.stage))].sort()
    : [];

  return {
    runId: input.runId,
    kind: "generate",
    outcome,
    importOffered,
    executableActionCount: r?.actions.length ?? 0,
    checklistItemCount: r?.checklist.length ?? 0,
    unsatisfiedItemCount: r?.completionStatus?.blockingFindings.length ?? 0,
    hardErrorStages,
    advisoryErrorCount: r?.advisoryIrErrors?.length ?? 0,
    warningCount: r?.warnings.length ?? 0,
    uncertaintyCount: r?.uncertainty.length ?? 0,
    descriptionLength: input.descriptionLength,
    redactedClasses: [...(input.redactedClasses ?? [])].sort(),
    containedSecret: input.containedSecret ?? false,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    cost: input.cost,
    provenance: input.provenance,
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    measuredAt: input.finishedAt,
  };
}

export interface MeasureRepairInput {
  /** The generation run being repaired, or a fresh id for a standalone repair. */
  runId: string;
  startedAt: number;
  finishedAt: number;
  /** Actions in the shortcut that came out. Absent when the repair threw. */
  repairedActionCount?: number | null;
  /** Blocking findings the repair was asked to fix. */
  requestedCount: number;
  /** Findings the engine reported it could not resolve. */
  unresolvedCount: number;
  errorKind?: RunErrorKind | null;
  provenance: RunProvenance;
}

/**
 * Pure. The repair analogue of `measureRun`, and deliberately conservative:
 * a repair only counts as `ready` when the engine both returned a shortcut and
 * reported nothing left unresolved.
 *
 * `importOffered` is always false — reaching a repaired shortcut is not the
 * same as being offered an import, and conflating them would inflate the exact
 * success metric the promotion gates depend on. Token cost is not metered on
 * this path yet, so it is recorded as zero rather than guessed.
 */
export function measureRepair(input: MeasureRepairInput): RunOutcome {
  const threw = Boolean(input.errorKind) || input.repairedActionCount == null;
  const unresolved = threw ? input.requestedCount : input.unresolvedCount;

  const outcome: RunOutcomeKind = threw
    ? "error"
    : unresolved > 0
      ? "incomplete"
      : "ready";

  return {
    runId: input.runId,
    kind: "repair",
    outcome,
    importOffered: false,
    executableActionCount: input.repairedActionCount ?? 0,
    checklistItemCount: 0,
    unsatisfiedItemCount: unresolved,
    hardErrorStages: [],
    advisoryErrorCount: 0,
    warningCount: unresolved,
    uncertaintyCount: 0,
    descriptionLength: 0,
    redactedClasses: [],
    containedSecret: false,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    cost: UNMETERED_COST,
    provenance: input.provenance,
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    measuredAt: input.finishedAt,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export interface OutcomeAggregate {
  runs: number;
  readyRate: number;
  importOfferedRate: number;
  failureRate: number;
  /** Runs with no completion status — should be zero. */
  unverifiedCount: number;
  meanTokens: number;
  meanDurationMs: number;
  /** Hard-error stage → count. The raw material for failure clustering. */
  failuresByStage: Record<string, number>;
}

export function aggregateOutcomes(outcomes: readonly RunOutcome[]): OutcomeAggregate {
  const runs = outcomes.length;
  if (runs === 0) {
    return {
      runs: 0,
      readyRate: 0,
      importOfferedRate: 0,
      failureRate: 0,
      unverifiedCount: 0,
      meanTokens: 0,
      meanDurationMs: 0,
      failuresByStage: {},
    };
  }

  let ready = 0;
  let offered = 0;
  let failed = 0;
  let unverified = 0;
  let tokens = 0;
  let duration = 0;
  const failuresByStage: Record<string, number> = {};

  for (const o of outcomes) {
    if (o.outcome === "ready") ready++;
    if (o.importOffered) offered++;
    if (o.outcome !== "ready") failed++;
    if (o.outcome === "unverified") unverified++;
    tokens += o.cost.totalTokens;
    duration += o.durationMs;
    for (const stage of o.hardErrorStages) {
      failuresByStage[stage] = (failuresByStage[stage] ?? 0) + 1;
    }
  }

  return {
    runs,
    readyRate: ready / runs,
    importOfferedRate: offered / runs,
    failureRate: failed / runs,
    unverifiedCount: unverified,
    meanTokens: tokens / runs,
    meanDurationMs: duration / runs,
    failuresByStage,
  };
}

// ── Benchmark comparison ──────────────────────────────────────────────────────

export interface BenchmarkComparison {
  improved: boolean;
  readyRateDelta: number;
  tokenDelta: number;
  /** True when the candidate regressed on any case the champion passed. */
  regressed: boolean;
  detail: string;
}

/**
 * Primitive behind the `benchmark-improvement` promotion gate.
 *
 * A candidate must raise the ready rate by at least `minImprovement` AND not
 * regress. Cost is reported but judged by the separate cost-ceiling gate, so a
 * cheap-but-worse candidate cannot pass here on price.
 */
export function compareBenchmarks(
  champion: OutcomeAggregate,
  challenger: OutcomeAggregate,
  minImprovement = 0.0,
): BenchmarkComparison {
  const readyRateDelta = challenger.readyRate - champion.readyRate;
  const tokenDelta = challenger.meanTokens - champion.meanTokens;
  const regressed = readyRateDelta < 0;
  const improved = !regressed && readyRateDelta > minImprovement;

  return {
    improved,
    readyRateDelta,
    tokenDelta,
    regressed,
    detail:
      `ready ${(champion.readyRate * 100).toFixed(1)}% → ${(challenger.readyRate * 100).toFixed(1)}% ` +
      `(${readyRateDelta >= 0 ? "+" : ""}${(readyRateDelta * 100).toFixed(1)} pts), ` +
      `mean tokens ${champion.meanTokens.toFixed(0)} → ${challenger.meanTokens.toFixed(0)}`,
  };
}
