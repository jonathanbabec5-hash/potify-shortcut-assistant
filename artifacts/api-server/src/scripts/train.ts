/**
 * Controlled offline training entry point.
 *
 *   pnpm --filter @workspace/api-server run train -- \
 *     --label "2026-07 device-confirmed" \
 *     --champion champion-v1 \
 *     --reviewed-by "Jane Doe" \
 *     --approved-by "Jane Doe" \
 *     --rollback-to champion-v1
 *
 * This is the job that was missing. The promotion apparatus existed and had
 * never gated anything, because nothing produced a challenger to gate. This
 * script is the only place the whole chain runs:
 *
 *   freeze batch → build candidate → benchmark champion → benchmark challenger
 *   → evaluate nine gates → record the decision
 *
 * ## What it will not do
 *
 * It never promotes. It writes a decision and stops. Promotion is a separate,
 * human act against a recorded decision — putting it here would give a batch
 * job the authority the governance model reserves for a person.
 *
 * It never invents a benchmark. If no model is reachable, it exits non-zero
 * rather than producing numbers, because a fabricated benchmark that passes the
 * gates is worse than no training at all.
 *
 * It is offline by construction: run by hand, never imported by the server.
 */

import { parseArgs } from "node:util";

import { BOOT_FINGERPRINT } from "../lib/learning/boot";
import { CostLedger, withCostLedger } from "../lib/learning/cost";
import { workflowSignatureOf } from "../lib/learning/records";
import { PROMOTION_GATES, isRollbackPlanUsable, type GateResult, type RollbackPlan } from "../lib/learning/governance";
import { EVAL_SET, assertEvalSetIntegrity, evalSetFingerprint } from "../lib/learning/eval-set";
import {
  HOLDOUT_SET,
  assertHoldoutIntegrity,
  holdoutFingerprint,
} from "../lib/learning/eval-holdout";
import { classifyCoverage, describeCoverage } from "../lib/learning/eval-coverage";
import { assessMaturity, describeMaturity } from "../lib/learning/maturity";
import {
  buildCandidate,
  candidateExists,
  compareChallenger,
  freezeTrainingBatch,
  markBatchStatus,
  mintAdapterBlock,
  persistCandidate,
  renderExemplarBlock,
  runBenchmark,
  runCycle,
  type BenchmarkArtifacts,
  type CaseRunner,
} from "../lib/learning/training";
import type { AdapterBlock } from "../lib/shortcuts/adapter";
import { runPipeline, runPipelineForBenchmark } from "../lib/shortcuts/pipeline";
import { classifyRefusal } from "../lib/shortcuts/refusal";
import { MODEL_CONFIG } from "../lib/shortcuts/model-config";
import type { RegressionCase } from "../lib/shortcuts/regression";

// ── Arguments ─────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    champion: { type: "string", default: "champion-v1" },
    "reviewed-by": { type: "string" },
    "approved-by": { type: "string" },
    "rollback-to": { type: "string" },
    "min-quality": { type: "string" },
    "max-exemplars": { type: "string" },
    "token-ceiling": { type: "string", default: "2000000" },
    "require-device-success": { type: "boolean", default: false },
  },
  strict: true,
});

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const label = values.label?.trim();
if (!label) die("--label is required. A batch without a label cannot be discussed later.");

const championId = values.champion!.trim();
const tokenCeiling = Number(values["token-ceiling"]);
if (!Number.isFinite(tokenCeiling) || tokenCeiling <= 0) die("--token-ceiling must be positive.");

// ── Case runner ───────────────────────────────────────────────────────────────

/**
 * Runs one evaluation case through the real pipeline.
 *
 * Champion and challenger differ by exactly one thing: the adapter. Same cases,
 * same validators, same model — otherwise a measured difference cannot be
 * attributed to what was learned.
 *
 * The champion side calls `runPipeline`, the production entry point, rather than
 * a benchmark variant with an empty adapter threaded through it. The baseline is
 * then literally the code path users get, not a near-copy of it.
 */
function runnerFor(adapter: AdapterBlock | undefined): CaseRunner {
  return async (testCase: RegressionCase) => {
    const ledger = new CostLedger(tokenCeiling);
    const startedAt = Date.now();

    const result = await withCostLedger(ledger, () =>
      adapter === undefined
        ? runPipeline(testCase.description)
        : runPipelineForBenchmark(testCase.description, undefined, {}, adapter),
    );

    const signature = workflowSignatureOf(result.shortcut);

    // A refusal is read from the structured hard-error list, exactly as the route
    // reads it for its 422 — never from message text, and never inferred from a
    // missing id.
    //
    // Crucially it is not "any hard error". Only grounding and parameter failures
    // mean the pipeline declined for lack of a basis to build; the other five
    // stages mean it built something broken. Counting those as refusals would let
    // a must-refuse case pass because generation fell over, rewarding a variant
    // for getting worse.
    const refusal = classifyRefusal(result.hardIrErrors);
    const refused = refusal.refused;
    const reason = refusal.otherHardStages.length
      ? `${refusal.reason} (also failed: ${refusal.otherHardStages.join(", ")})`
      : refusal.reason;

    return {
      actionSequence: signature.actionSequence,
      controlFlowDepth: signature.controlFlowDepth,
      checklistSatisfied: result.checklistSatisfied,
      // The governing invariant: an id exists only when the shortcut is
      // genuinely importable. Re-deriving importability any other way here
      // would be a second, weaker definition of the same thing.
      importable: typeof result.id === "string" && result.id.length > 0,
      refused,
      ...(refused ? { refusalReason: reason } : {}),
      durationMs: Date.now() - startedAt,
      totalTokens: ledger.summary().totalTokens,
    };
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = Date.now();

  // ── What this run is standing on ────────────────────────────────────────────
  //
  // Printed before anything else, and before the model-provider check, because an
  // operator deciding whether to trust a promotion decision needs to see which of
  // its dependencies have ever actually run. Every level is derived from live row
  // counts, so this cannot flatter itself.
  const maturity = await assessMaturity(now);
  console.log(`\n${describeMaturity(maturity)}\n`);

  // ── A model is mandatory ────────────────────────────────────────────────────
  //
  // Checked here rather than at import time so the evidence above is always
  // printed first — the blocker is far easier to act on with the dependency
  // levels in view.
  if (!maturity.modelProviderConfigured) {
    die(
      "No model provider is configured, so no benchmark can be run.\n" +
        "    Set OPENROUTER_API_KEY (or a working AI_INTEGRATIONS_OPENAI_API_KEY) and retry.\n" +
        "    Refusing to emit a promotion decision backed by no measurement.",
    );
  }

  // Integrity first. Benchmarking against a mutated suite measures nothing.
  assertEvalSetIntegrity();
  assertHoldoutIntegrity();

  // Coverage second. A case that names an action the catalog does not define can
  // never pass, for either variant, so it contributes nothing to the delta while
  // looking like a shared failure. Those cases are reported as "cannot run" and
  // excluded from scoring — not counted as failures, and not quietly dropped.
  const evalCoverage = classifyCoverage(EVAL_SET);
  const holdoutCoverage = classifyCoverage(HOLDOUT_SET);

  console.log("\n▸ Suites");
  console.log(describeCoverage("eval-set", evalCoverage));
  console.log(describeCoverage("holdout ", holdoutCoverage));

  // The fingerprint covers what actually ran, not the suite on disk. If the
  // catalog later grows and more cases become scoreable, the fingerprint changes
  // and `compareChallenger` correctly refuses to compare across that boundary.
  const suiteFingerprint = evalSetFingerprint(evalCoverage.runnable);
  const holdoutSuiteFingerprint = holdoutFingerprint(holdoutCoverage.runnable);

  if (evalCoverage.runnable.length === 0) {
    die(
      "No eval case can be scored against the current catalog, so no benchmark is possible.\n" +
        "    Every case names at least one action the catalog does not define. Grow the catalog\n" +
        "    or register a case that today's catalog can express — do not edit a locked case.",
    );
  }
  if (holdoutCoverage.runnable.length === 0) {
    die(
      "No held-out case can be scored against the current catalog.\n" +
        "    Without a holdout there is no evidence of generalisation, only of fitting the\n" +
        "    cases the pipeline was built against. Refusing to produce a decision.",
    );
  }

  // 1 ── Freeze
  const batch = await freezeTrainingBatch(
    label!,
    BOOT_FINGERPRINT,
    {
      ...(values["min-quality"] ? { minQualityScore: Number(values["min-quality"]) } : {}),
      requireDeviceSuccess: values["require-device-success"],
    },
    now,
  );
  console.log(`▸ Frozen batch ${batch.id} — ${batch.memberCount} members`);

  // 2 ── Candidate
  const candidate = await buildCandidate(
    batch,
    {
      parentChampionId: championId,
      ...(values["max-exemplars"] ? { maxExemplars: Number(values["max-exemplars"]) } : {}),
    },
    now,
  );
  await persistCandidate(candidate);

  console.log(
    `▸ Candidate ${candidate.id} (${candidate.exemplars.length} exemplars, ` +
      `~${candidate.estimatedPromptTokens} prompt tokens)`,
  );
  console.log(`  exclusions: ${JSON.stringify(candidate.exclusions)}`);

  // 3 ── Benchmarks
  // Minting fails loudly on empty exemplar text, so a candidate that rendered to
  // nothing can never be benchmarked as if it were a real challenger.
  const challengerAdapter = mintAdapterBlock({
    text: renderExemplarBlock(candidate.exemplars),
    candidateId: candidate.id,
  });

  // Recorded on every benchmark so a comparison can prove the prompt policy and
  // catalog did not move between the two runs.
  const artifacts: BenchmarkArtifacts = {
    promptPolicyHash: BOOT_FINGERPRINT.systemPromptHash,
    catalogHash: BOOT_FINGERPRINT.catalogHash,
  };

  console.log(`▸ Benchmarking champion ${championId}…`);
  const championBenchmark = await runBenchmark(
    championId,
    "eval-set",
    suiteFingerprint,
    evalCoverage.runnable,
    runnerFor(undefined),
    artifacts,
  );
  console.log(`  champion pass rate ${(championBenchmark.passRate * 100).toFixed(1)}%`);

  console.log(`▸ Benchmarking challenger ${candidate.id}…`);
  const challengerBenchmark = await runBenchmark(
    candidate.id,
    "eval-set",
    suiteFingerprint,
    evalCoverage.runnable,
    runnerFor(challengerAdapter),
    artifacts,
  );
  console.log(`  challenger pass rate ${(challengerBenchmark.passRate * 100).toFixed(1)}%`);

  // ── Held-out suite: its own comparison, never pooled with the eval set ──
  //
  // Pooling would let a gain on the cases the pipeline was designed against
  // mask a regression on the cases it has never seen — which is the only signal
  // that says anything about generalisation. `compareChallenger` refuses
  // mismatched suites, so the two comparisons stay structurally separate.
  console.log("▸ Benchmarking held-out suite…");
  const championHoldout = await runBenchmark(
    championId,
    "holdout",
    holdoutSuiteFingerprint,
    holdoutCoverage.runnable,
    runnerFor(undefined),
    artifacts,
  );
  const challengerHoldout = await runBenchmark(
    candidate.id,
    "holdout",
    holdoutSuiteFingerprint,
    holdoutCoverage.runnable,
    runnerFor(challengerAdapter),
    artifacts,
  );
  const holdoutComparison = compareChallenger(championHoldout, challengerHoldout);
  console.log(
    `  holdout champion ${(championHoldout.passRate * 100).toFixed(1)}% → ` +
      `challenger ${(challengerHoldout.passRate * 100).toFixed(1)}% ` +
      `(${holdoutComparison.regressions.length} regression(s))`,
  );

  // 4 ── Caller-supplied gates
  //
  // The loop derives deterministic-validation, benchmark-improvement,
  // regression, and cost-ceiling from the benchmarks. The remaining five are
  // judgements this job cannot make on its own, so each one requires evidence
  // to have been supplied explicitly. Absent evidence is a missing gate, and a
  // missing gate blocks exactly like a failed one.
  const reviewedBy = values["reviewed-by"]?.trim();
  const approvedBy = values["approved-by"]?.trim();
  const rollbackTo = values["rollback-to"]?.trim();

  const rollbackPlan: RollbackPlan = {
    revertTo: rollbackTo ?? "",
    method: "config-flag",
    triggerMetric: "importable-rate",
    triggerThreshold: Math.max(0, championBenchmark.passRate - 0.05),
    recordedAt: now,
  };

  const piiSuspected = candidate.exclusions.piiSuspected;

  // A rollback target has to be something there is actually a way back to:
  // either the champion currently serving production, or a stored candidate.
  // Accepting an arbitrary string would let the gate pass on a plan that
  // cannot be carried out.
  const rollbackTargetIsReal =
    Boolean(rollbackTo) && (rollbackTo === championId || (await candidateExists(rollbackTo!)));

  const gates: GateResult[] = [
    {
      gate: "privacy-safety-review",
      // A finding here means redaction failed upstream. That is not something a
      // reviewer's signature should be able to wave through.
      passed: Boolean(reviewedBy) && piiSuspected === 0,
      detail: reviewedBy
        ? piiSuspected === 0
          ? `Reviewed by ${reviewedBy}; no PII suspected in ${candidate.exemplars.length} exemplars.`
          : `BLOCKED: ${piiSuspected} exemplar(s) tripped PII re-detection despite redaction at write time.`
        : "No reviewer supplied (--reviewed-by).",
      evaluatedAt: now,
    },
    {
      // Strengthened, not replaced. It still requires that both variants ran the
      // same eval suite, and now additionally requires a comparable held-out run
      // with no regressions on it. A gain confined to the cases the pipeline was
      // designed against is not evidence of learning, and a held-out regression
      // is disqualifying however good the eval delta looks.
      //
      // Folded into this existing gate deliberately: `evaluatePromotion` grants no
      // authority to a gate id it does not recognise, so inventing one would have
      // produced a check with no power to block.
      gate: "champion-challenger",
      passed:
        championBenchmark.suiteFingerprint === challengerBenchmark.suiteFingerprint &&
        holdoutComparison.comparable &&
        holdoutComparison.regressions.length === 0,
      detail:
        championBenchmark.suiteFingerprint !== challengerBenchmark.suiteFingerprint
          ? "BLOCKED: champion and challenger did not run the same eval suite."
          : !holdoutComparison.comparable
            ? "BLOCKED: held-out runs are not comparable (suite, prompt policy, or catalog moved between runs)."
            : holdoutComparison.regressions.length > 0
              ? `BLOCKED: held-out regressions on ${holdoutComparison.regressions.join(", ")} — a gain on the design cases does not offset losing cases the pipeline has never seen.`
              : `Same eval suite (${suiteFingerprint.slice(0, 12)}…); held-out suite ${holdoutCoverage.runnable.length} case(s), no regressions, delta ${(holdoutComparison.passRateDelta * 100).toFixed(2)}pp.`,
      evaluatedAt: now,
    },
    {
      gate: "versioning",
      passed: candidate.version.length > 0 && candidate.id !== championId,
      detail: `Candidate ${candidate.id} version ${candidate.version}, parent ${candidate.parentChampionId}, content ${candidate.contentHash.slice(0, 12)}….`,
      evaluatedAt: now,
    },
    {
      gate: "rollback-plan",
      passed: isRollbackPlanUsable(rollbackPlan) && rollbackTargetIsReal,
      detail: !rollbackTo
        ? "No rollback target supplied (--rollback-to)."
        : rollbackTargetIsReal
          ? `Revert to ${rollbackTo} by config flag if importable-rate drops below ${rollbackPlan.triggerThreshold.toFixed(3)}.`
          : `BLOCKED: rollback target "${rollbackTo}" is neither the current champion nor a stored candidate, so the plan cannot actually be carried out.`,
      evaluatedAt: now,
    },
    {
      gate: "human-approval",
      passed: Boolean(approvedBy),
      detail: approvedBy ? `Approved by ${approvedBy}.` : "No approver supplied (--approved-by).",
      evaluatedAt: now,
    },
  ];

  // 5 ── Decide (records only; promotes nothing)
  // Iteration 1: this script runs a single supervised iteration per invocation.
  // The loop's 3-iteration bound stays meaningful because each run is a
  // deliberate human act rather than an unattended retry.
  const cycle = await runCycle(1, {
    championBenchmark,
    challengerBenchmark,
    batch,
    gates,
    rollbackPlan,
    trainingTokens: championBenchmark.totalTokens + challengerBenchmark.totalTokens,
    tokenCeiling,
  });

  await markBatchStatus(batch.id, "trained");

  // ── Report ──
  const { decision, comparison } = cycle;
  console.log(`\n${"─".repeat(64)}`);
  console.log(`Decision: ${decision.approved ? "APPROVED" : "BLOCKED"}`);
  console.log(
    `Eval    (${evalCoverage.runnable.length} scored, ${evalCoverage.unrunnable.length} cannot run): ` +
      `delta ${(comparison.passRateDelta * 100).toFixed(2)}pp`,
  );
  console.log(
    `Holdout (${holdoutCoverage.runnable.length} scored, ${holdoutCoverage.unrunnable.length} cannot run): ` +
      `delta ${(holdoutComparison.passRateDelta * 100).toFixed(2)}pp` +
      `${holdoutComparison.comparable ? "" : " [NOT COMPARABLE]"}`,
  );
  console.log(`Regressions: ${comparison.regressions.join(", ") || "none"}`);
  console.log(`Holdout regressions: ${holdoutComparison.regressions.join(", ") || "none"}`);
  console.log(`Improvements: ${comparison.improvements.join(", ") || "none"}`);
  if (decision.failed.length) console.log(`Failed gates: ${decision.failed.join(", ")}`);
  if (decision.missing.length) console.log(`Missing gates: ${decision.missing.join(", ")}`);
  if (decision.conflicted.length) console.log(`Conflicted gates: ${decision.conflicted.join(", ")}`);
  if (cycle.terminated) console.log(`Terminated: ${cycle.terminationReason}`);
  console.log(`Gates evaluated: ${gates.length} supplied of ${PROMOTION_GATES.length} total`);
  console.log(`${"─".repeat(64)}`);
  console.log(
    decision.approved
      ? `\n  Candidate ${candidate.id} cleared every gate.\n` +
          `  It has NOT been promoted. Promotion is a separate, deliberate step.\n`
      : `\n  Candidate ${candidate.id} was not approved. Nothing changed.\n`,
  );

  process.exit(decision.approved ? 0 : 2);
}

main().catch((error: unknown) => {
  console.error(`\n  ✗ Training run failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
