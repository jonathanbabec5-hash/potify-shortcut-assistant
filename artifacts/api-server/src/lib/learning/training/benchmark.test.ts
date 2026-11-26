/**
 * Benchmark scoring.
 *
 * The harness takes its runner as an argument, so every case here is scored
 * against a stub — no model, no database, no pipeline. That is the point: these
 * assertions are about how outcomes are *judged*, and a real runner would make
 * them depend on model behaviour.
 *
 * The must-refuse tests exist because of a specific near-miss. Scoring a
 * must-refuse case on "no shortcut came out" would have marked a run as a
 * successful refusal when generation had simply fallen over — measuring the
 * opposite of the capability, and rewarding a variant for getting worse.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { compareChallenger, runBenchmark, type BenchmarkArtifacts } from "./benchmark";
import { classifyRefusal, refusalStages } from "../../shortcuts/refusal";
import type { IRValidationError, IRValidationStage } from "../../shortcuts/pipeline-types";
import type { RegressionCase } from "../../shortcuts/regression";

const ARTIFACTS: BenchmarkArtifacts = { promptPolicyHash: "policy-1", catalogHash: "catalog-1" };

function hardError(stage: IRValidationStage): IRValidationError {
  return { stage, message: "m", suggestion: "s", advisory: false };
}

function caseOf(overrides: Partial<RegressionCase> = {}): RegressionCase {
  return {
    id: "T-001",
    description: "a test case description that is long enough",
    intentChecklist: [{ id: "IC-1", description: "does the thing", category: "structure" }],
    expectedActionSequence: ["is.workflow.actions.notification"],
    expectedControlFlowDepth: 0,
    assertions: [{ label: "l", predicate: "p" }],
    ...overrides,
  } as RegressionCase;
}

/** A runner that reports whatever outcome the test wants to score. */
function stubRunner(outcome: {
  actionSequence?: string[];
  controlFlowDepth?: number;
  checklistSatisfied?: boolean;
  importable?: boolean;
  refused?: boolean;
  refusalReason?: string;
}) {
  return async () => ({
    actionSequence: outcome.actionSequence ?? [],
    controlFlowDepth: outcome.controlFlowDepth ?? 0,
    checklistSatisfied: outcome.checklistSatisfied ?? true,
    importable: outcome.importable ?? true,
    refused: outcome.refused ?? false,
    ...(outcome.refusalReason !== undefined ? { refusalReason: outcome.refusalReason } : {}),
    durationMs: 1,
    totalTokens: 10,
  });
}

async function scoreOne(testCase: RegressionCase, runner: ReturnType<typeof stubRunner>) {
  const result = await runBenchmark("v", "suite", "fp", [testCase], runner, ARTIFACTS);
  return result.cases[0]!;
}

// ── Refusal classification ────────────────────────────────────────────────────

test("only grounding and parameter failures count as refusals", () => {
  assert.deepEqual(refusalStages(), ["grounding", "parameters"]);

  for (const stage of ["grounding", "parameters"] as const) {
    assert.equal(classifyRefusal([hardError(stage)]).refused, true, `${stage} should be a refusal`);
  }

  // Every one of these means the model produced something and it was wrong. That
  // is a generation defect, not a principled decision not to build.
  for (const stage of ["variables", "controlflow", "checklist", "platform", "invention"] as const) {
    assert.equal(
      classifyRefusal([hardError(stage)]).refused,
      false,
      `${stage} must NOT count as a refusal`,
    );
  }
});

test("no hard errors is not a refusal", () => {
  const classification = classifyRefusal([]);
  assert.equal(classification.refused, false);
  assert.equal(classification.reason, "");
});

test("a refusal that also broke something reports both", () => {
  const classification = classifyRefusal([hardError("grounding"), hardError("controlflow")]);
  assert.equal(classification.refused, true);
  assert.equal(classification.reason, "grounding");
  assert.deepEqual(classification.otherHardStages, ["controlflow"]);
});

// ── Must-refuse scoring ───────────────────────────────────────────────────────

const MUST_REFUSE = caseOf({
  id: "T-REFUSE",
  mustRefuse: true,
  expectedActionSequence: [],
  expectedControlFlowDepth: 0,
});

test("a must-refuse case passes when the pipeline declines and offers no import", async () => {
  const scored = await scoreOne(
    MUST_REFUSE,
    stubRunner({ refused: true, refusalReason: "grounding", importable: false }),
  );
  assert.equal(scored.passed, true, `unexpected failures: ${scored.failures.join(", ")}`);
});

test("a must-refuse case fails when the pipeline generated instead of declining", async () => {
  const scored = await scoreOne(MUST_REFUSE, stubRunner({ refused: false, importable: true }));
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.includes("expected-refusal-but-generated"));
});

test("an unrelated hard failure does not score as a refusal", async () => {
  // The near-miss this whole distinction exists for. A run that fell over on
  // control-flow validation produces no importable shortcut, so a naive scorer
  // would call it a successful refusal. `classifyRefusal` reports refused=false
  // for that stage, so the case correctly fails.
  assert.equal(classifyRefusal([hardError("controlflow")]).refused, false);

  const scored = await scoreOne(MUST_REFUSE, stubRunner({ refused: false, importable: false }));
  assert.equal(scored.passed, false, "a generation defect must not pass a must-refuse case");
  assert.ok(scored.failures.includes("expected-refusal-but-generated"));
});

test("a must-refuse case fails if an import was offered, even alongside a refusal", async () => {
  // The governing invariant, checked directly. If an id came out, the user was
  // offered something the pipeline had no basis to build.
  const scored = await scoreOne(
    MUST_REFUSE,
    stubRunner({ refused: true, refusalReason: "grounding", importable: true }),
  );
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.includes("import-offered-despite-refusal"));
});

test("an ordinary case that was refused fails, and says so", async () => {
  const scored = await scoreOne(
    caseOf(),
    stubRunner({ refused: true, refusalReason: "grounding", importable: false }),
  );
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.some((f) => f.startsWith("refused(")));
});

// ── Wildcards ─────────────────────────────────────────────────────────────────

test("a wildcard family matches any identifier in that family", async () => {
  const scored = await scoreOne(
    caseOf({ expectedActionSequence: ["[HOMEKIT:set-on]"] }),
    stubRunner({ actionSequence: ["is.workflow.actions.homekit.setstate"] }),
  );
  assert.equal(scored.passed, true, `unexpected failures: ${scored.failures.join(", ")}`);
});

test("an unknown wildcard family fails loudly instead of matching everything", async () => {
  const result = await runBenchmark(
    "v",
    "suite",
    "fp",
    [caseOf({ expectedActionSequence: ["[NOSUCHFAMILY:do-it]"] })],
    stubRunner({ actionSequence: ["anything.at.all"] }),
    ARTIFACTS,
  );
  // Surfaced as a case failure by the harness's own catch, never as a pass.
  assert.equal(result.cases[0]!.passed, false);
});

// ── Vacuous results are not representable ─────────────────────────────────────

test("a zero-case benchmark is refused rather than reported as 0%", async () => {
  await assert.rejects(
    () => runBenchmark("v", "suite", "fp", [], stubRunner({}), ARTIFACTS),
    /zero cases/,
  );
});

// ── Comparability ─────────────────────────────────────────────────────────────

test("a comparison is refused when the prompt policy or catalog moved between runs", async () => {
  const cases = [caseOf()];
  const champion = await runBenchmark("champ", "suite", "fp", cases, stubRunner({}), ARTIFACTS);

  const policyMoved = await runBenchmark("chall", "suite", "fp", cases, stubRunner({}), {
    promptPolicyHash: "policy-2",
    catalogHash: "catalog-1",
  });
  assert.equal(compareChallenger(champion, policyMoved).comparable, false);

  const catalogMoved = await runBenchmark("chall", "suite", "fp", cases, stubRunner({}), {
    promptPolicyHash: "policy-1",
    catalogHash: "catalog-2",
  });
  assert.equal(compareChallenger(champion, catalogMoved).comparable, false);

  const same = await runBenchmark("chall", "suite", "fp", cases, stubRunner({}), ARTIFACTS);
  assert.equal(compareChallenger(champion, same).comparable, true);
});
