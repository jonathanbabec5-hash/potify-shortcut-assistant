/**
 * The bounded improvement loop.
 *
 * ⚠️  Offline only. Nothing in the request path may import this module.
 *
 * "Recursive self-improvement" is treated here as a strictly bounded,
 * human-terminated procedure: evaluate → learn → test → propose. Four hard
 * limits keep it that way:
 *
 *  1. **Iteration cap.** The cycle cannot run more than MAX_ITERATIONS times.
 *  2. **One batch per cycle.** Learning cannot fan out.
 *  3. **It never applies anything.** The loop's terminal output is a recorded
 *     PromotionDecision. Swapping the champion is a deployment, performed by a
 *     human, outside this process.
 *  4. **All nine gates, no override.** `evaluatePromotion` is fail-closed and
 *     takes no bypass parameter; a missing gate blocks exactly like a failed one.
 *
 * The fourth point is the one that matters most. Every other limit is a policy
 * that could be loosened; that one is structural. There is no argument you can
 * pass to this function that promotes an unproven candidate.
 */

import { db, promotionDecisions } from "@workspace/db";

import {
  evaluatePromotion,
  PROMOTION_GATES,
  type GateResult,
  type PromotionDecision,
  type PromotionRequest,
  type RollbackPlan,
} from "../governance";
import { assertEvalSetIntegrity } from "../eval-set";
import { assertHoldoutIntegrity } from "../eval-holdout";
import { verifyBatchIntegrity, type FrozenBatch } from "./batch";
import {
  compareChallenger,
  type BenchmarkResult,
  type ChallengerComparison,
} from "./benchmark";

/** A cycle that has not converged in three attempts needs a person, not a fourth. */
export const MAX_ITERATIONS = 3;

export interface CycleInput {
  championBenchmark: BenchmarkResult;
  challengerBenchmark: BenchmarkResult;
  batch: FrozenBatch;
  gates: readonly GateResult[];
  rollbackPlan: RollbackPlan;
  /** Cumulative token cost of producing the challenger. */
  trainingTokens: number;
  tokenCeiling: number;
}

export interface CycleResult {
  iteration: number;
  comparison: ChallengerComparison;
  decision: PromotionDecision;
  /** True when the loop must stop regardless of the decision. */
  terminated: boolean;
  terminationReason?: string;
}

export class LoopBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopBoundError";
  }
}

/**
 * Runs one iteration and records the decision.
 *
 * Integrity of both eval suites is asserted first and will throw. Benchmarking
 * against a set that may have been edited is worse than not benchmarking at
 * all, because it produces a number people trust.
 */
export async function runCycle(
  iteration: number,
  input: CycleInput,
  now: number = Date.now(),
): Promise<CycleResult> {
  if (iteration < 1 || iteration > MAX_ITERATIONS) {
    throw new LoopBoundError(
      `Iteration ${iteration} is outside the permitted range 1..${MAX_ITERATIONS}.`,
    );
  }

  assertEvalSetIntegrity();
  assertHoldoutIntegrity();

  const integrity = await verifyBatchIntegrity(input.batch.id);
  const comparison = compareChallenger(input.championBenchmark, input.challengerBenchmark);

  // Findings the loop itself contributes, on top of whatever gates the caller
  // supplies. Each is expressed as a gate result so it flows through the same
  // fail-closed evaluation rather than being handled specially.
  const derived: GateResult[] = [
    {
      gate: "deterministic-validation",
      passed: input.challengerBenchmark.failed === 0,
      detail: `${input.challengerBenchmark.passed}/${input.challengerBenchmark.total} cases pass deterministic validation.`,
      evaluatedAt: now,
    },
    {
      gate: "benchmark-improvement",
      passed: comparison.comparable && comparison.passRateDelta > 0,
      detail: comparison.comparable
        ? `Pass rate delta ${comparison.passRateDelta >= 0 ? "+" : ""}${comparison.passRateDelta}.`
        : "Champion and challenger ran different suites; comparison refused.",
      evaluatedAt: now,
    },
    {
      gate: "regression",
      passed: comparison.comparable && comparison.regressions.length === 0,
      detail:
        comparison.regressions.length === 0
          ? "No previously-passing case regressed."
          : `Regressed: ${comparison.regressions.join(", ")}.`,
      evaluatedAt: now,
    },
    {
      gate: "cost-ceiling",
      passed: input.trainingTokens <= input.tokenCeiling,
      detail: `${input.trainingTokens} of ${input.tokenCeiling} tokens.`,
      evaluatedAt: now,
    },
  ];

  // A batch whose membership was tampered with poisons the whole cycle.
  if (!integrity.membershipIntact) {
    derived.push({
      gate: "privacy-safety-review",
      passed: false,
      detail: `Batch ${input.batch.id} membership does not match its frozen manifest.`,
      evaluatedAt: now,
    });
  }

  const results = mergeGates(input.gates, derived);
  const request: PromotionRequest = {
    candidateId: input.challengerBenchmark.variantId,
    championId: input.championBenchmark.variantId,
    results,
  };

  const decision = evaluatePromotion(request, now);

  await db.insert(promotionDecisions).values({
    candidateId: request.candidateId,
    championId: request.championId,
    batchId: input.batch.id,
    approved: decision.approved,
    gateResults: results as unknown[],
    failedGates: decision.failed,
    missingGates: decision.missing,
    conflictedGates: decision.conflicted,
    benchmark: comparison as unknown as Record<string, unknown>,
    rollbackPlan: input.rollbackPlan as unknown as Record<string, unknown>,
    approvedBy: gateApprover(results),
    summary: decision.summary,
    decidedAt: new Date(now),
  });

  const terminated = decision.approved || iteration >= MAX_ITERATIONS;
  return {
    iteration,
    comparison,
    decision,
    terminated,
    ...(terminated
      ? {
          terminationReason: decision.approved
            ? "Candidate cleared all promotion gates; awaiting human deployment."
            : `Iteration cap of ${MAX_ITERATIONS} reached without promotion.`,
        }
      : {}),
  };
}

/**
 * Caller-supplied gates win only when they are *more* restrictive.
 *
 * Otherwise a caller could pass `{gate: "regression", passed: true}` and
 * override the harness's own measurement of a regression it just observed.
 */
function mergeGates(
  supplied: readonly GateResult[],
  derived: readonly GateResult[],
): GateResult[] {
  const merged = new Map<string, GateResult>();
  for (const gate of supplied) merged.set(gate.gate, gate);
  for (const gate of derived) {
    const existing = merged.get(gate.gate);
    if (!existing || existing.passed) merged.set(gate.gate, gate);
  }
  return [...merged.values()];
}

function gateApprover(gates: readonly GateResult[]): string | null {
  const approval = gates.find((g) => g.gate === "human-approval" && g.passed);
  return approval?.detail ?? null;
}

/** The gates a caller must supply; the rest are derived by the loop itself. */
export const CALLER_SUPPLIED_GATES = Object.freeze(
  PROMOTION_GATES.filter(
    (g) =>
      !["deterministic-validation", "benchmark-improvement", "regression", "cost-ceiling"].includes(
        g,
      ),
  ),
);
