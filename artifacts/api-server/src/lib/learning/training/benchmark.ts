/**
 * Benchmark harness for champion-vs-challenger comparison.
 *
 * ⚠️  Offline only. Nothing in the request path may import this module.
 *
 * The harness takes the case runner as an argument rather than importing the
 * pipeline. That is what keeps training genuinely separated from inference:
 * this module has no path to a production prompt, catalog, or model client, so
 * it cannot accidentally exercise or mutate one. The caller — an offline script
 * — supplies a runner bound to whichever variant is under test.
 */

import type { RegressionCase } from "../../shortcuts/regression";
import { identifierMatches } from "../placeholder-families";

export interface CaseResult {
  caseId: string;
  passed: boolean;
  /** Which expectation failed. Empty when passed. */
  failures: string[];
  durationMs: number;
  totalTokens: number;
}

export interface BenchmarkResult {
  variantId: string;
  suite: string;
  /** Integrity fingerprint of the case set this ran against. */
  suiteFingerprint: string;
  /**
   * Hash of the fixed prompt policy in force during the run.
   *
   * Recorded because a comparison across two different policies measures the
   * policy edit, not the candidate. Checked by `compareChallenger`.
   */
  promptPolicyHash: string;
  /** Hash of the action catalog in force during the run. Same reasoning. */
  catalogHash: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  meanDurationMs: number;
  totalTokens: number;
  cases: CaseResult[];
  ranAt: number;
}

/**
 * Runs one case and reports what the pipeline did. Supplied by the caller.
 *
 * Returning failure information rather than throwing keeps one bad case from
 * aborting the suite — a benchmark with a hole in it is worse than useless.
 */
export type CaseRunner = (testCase: RegressionCase) => Promise<{
  actionSequence: string[];
  controlFlowDepth: number;
  checklistSatisfied: boolean;
  importable: boolean;
  /**
   * True when the pipeline declined to produce a shortcut — a clarification
   * request, a hard validation stop, or any other refusal to guess.
   *
   * Required, not optional: refusal is the correct answer for some cases and the
   * wrong answer for others, so a runner that did not report it would leave the
   * harness unable to tell a well-behaved refusal from a silent failure.
   */
  refused: boolean;
  refusalReason?: string;
  durationMs: number;
  totalTokens: number;
}>;

function compareCase(
  testCase: RegressionCase,
  actual: Awaited<ReturnType<CaseRunner>>,
): string[] {
  const failures: string[] = [];

  // A case that must be refused is scored on the refusal, not on a sequence — its
  // sequence and depth fields describe nothing, so checking them would fail every
  // such case.
  //
  // Two conditions, both required. `refused` says the pipeline declined for a
  // refusal-class reason (see `classifyRefusal`): without it, a run that merely
  // fell over would score as a principled refusal. `!importable` enforces the
  // governing invariant directly: if an importable shortcut came out, the case
  // failed no matter what the error list says, because the user was offered
  // something the pipeline had no basis to build.
  if (testCase.mustRefuse === true) {
    if (!actual.refused) failures.push("expected-refusal-but-generated");
    if (actual.importable) failures.push("import-offered-despite-refusal");
    return failures;
  }

  if (actual.refused) {
    failures.push(`refused(${actual.refusalReason ?? "unspecified"})`);
    // No output to compare against; further checks would just add noise.
    return failures;
  }

  if (!actual.checklistSatisfied) failures.push("checklist-unsatisfied");
  if (!actual.importable) failures.push("not-importable");

  if (actual.controlFlowDepth !== testCase.expectedControlFlowDepth) {
    failures.push(
      `depth-mismatch(expected ${testCase.expectedControlFlowDepth}, got ${actual.controlFlowDepth})`,
    );
  }

  const expected = testCase.expectedActionSequence;
  if (actual.actionSequence.length !== expected.length) {
    failures.push(
      `sequence-length(expected ${expected.length}, got ${actual.actionSequence.length})`,
    );
  } else {
    for (let i = 0; i < expected.length; i += 1) {
      if (!identifierMatches(expected[i]!, actual.actionSequence[i])) {
        failures.push(`sequence[${i}](expected ${expected[i]}, got ${actual.actionSequence[i]})`);
      }
    }
  }

  return failures;
}

export interface BenchmarkArtifacts {
  /** See `BenchmarkResult.promptPolicyHash`. */
  promptPolicyHash: string;
  catalogHash: string;
}

export async function runBenchmark(
  variantId: string,
  suite: string,
  suiteFingerprint: string,
  cases: readonly RegressionCase[],
  run: CaseRunner,
  artifacts: BenchmarkArtifacts,
  now: number = Date.now(),
): Promise<BenchmarkResult> {
  // A benchmark over zero cases reports a pass rate of 0 for both variants and a
  // delta of exactly 0. That is indistinguishable from "the candidate made no
  // difference" while actually meaning "nothing was measured", so it must not be
  // representable as a result at all.
  if (cases.length === 0) {
    throw new Error(
      `Refusing to run benchmark "${suite}" over zero cases: a pass rate of 0/0 is not evidence.`,
    );
  }

  const results: CaseResult[] = [];

  for (const testCase of cases) {
    try {
      const actual = await run(testCase);
      const failures = compareCase(testCase, actual);
      results.push({
        caseId: testCase.id,
        passed: failures.length === 0,
        failures,
        durationMs: actual.durationMs,
        totalTokens: actual.totalTokens,
      });
    } catch (err) {
      // An exception is a failure, not an excuse to skip the case. Skipping
      // would inflate the pass rate of whichever variant crashes more.
      results.push({
        caseId: testCase.id,
        passed: false,
        failures: [`threw: ${err instanceof Error ? err.name : "unknown"}`],
        durationMs: 0,
        totalTokens: 0,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    variantId,
    suite,
    suiteFingerprint,
    promptPolicyHash: artifacts.promptPolicyHash,
    catalogHash: artifacts.catalogHash,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : Number((passed / results.length).toFixed(4)),
    meanDurationMs:
      results.length === 0
        ? 0
        : Math.round(results.reduce((n, r) => n + r.durationMs, 0) / results.length),
    totalTokens: results.reduce((n, r) => n + r.totalTokens, 0),
    cases: results,
    ranAt: now,
  };
}

export interface ChallengerComparison {
  championId: string;
  challengerId: string;
  passRateDelta: number;
  /** Cases the champion passed and the challenger failed. */
  regressions: string[];
  /** Cases the challenger fixed. */
  improvements: string[];
  tokenDelta: number;
  latencyDelta: number;
  /** Both suites must have run the same cases, or the comparison is meaningless. */
  comparable: boolean;
}

export function compareChallenger(
  champion: BenchmarkResult,
  challenger: BenchmarkResult,
): ChallengerComparison {
  const championCases = new Map(champion.cases.map((c) => [c.caseId, c]));
  const challengerCases = new Map(challenger.cases.map((c) => [c.caseId, c]));

  // Different case sets, or a different fingerprint for the same suite name,
  // means someone changed the benchmark between runs. Refuse to compare.
  //
  // The prompt policy and catalog are checked for the same reason. A candidate is
  // supposed to be the *only* difference between the two runs; if the policy text
  // or the action catalog moved in between, the delta measures that edit and
  // attributes it to the candidate. Both are recorded per run precisely so this
  // check is possible.
  const comparable =
    champion.suiteFingerprint === challenger.suiteFingerprint &&
    champion.promptPolicyHash === challenger.promptPolicyHash &&
    champion.catalogHash === challenger.catalogHash &&
    championCases.size === challengerCases.size &&
    [...championCases.keys()].every((id) => challengerCases.has(id));

  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [id, championCase] of championCases) {
    const challengerCase = challengerCases.get(id);
    if (!challengerCase) continue;
    if (championCase.passed && !challengerCase.passed) regressions.push(id);
    if (!championCase.passed && challengerCase.passed) improvements.push(id);
  }

  return {
    championId: champion.variantId,
    challengerId: challenger.variantId,
    passRateDelta: Number((challenger.passRate - champion.passRate).toFixed(4)),
    regressions: regressions.sort(),
    improvements: improvements.sort(),
    tokenDelta: challenger.totalTokens - champion.totalTokens,
    latencyDelta: challenger.meanDurationMs - champion.meanDurationMs,
    comparable,
  };
}
