/**
 * Integrity checks only.
 *
 * There is deliberately no test asserting that the pipeline PASSES these cases.
 * The held-out set exists to measure generalisation at promotion time; a test
 * that required it to pass would make it a development target and it would stop
 * measuring anything. See the header of eval-holdout.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOLDOUT_MANIFEST,
  HOLDOUT_SET,
  assertHoldoutIntegrity,
  holdoutFingerprint,
  verifyHoldoutIntegrity,
} from "./eval-holdout";
import { EVAL_SET, hashCase } from "./eval-set";
import type { RegressionCase } from "../shortcuts/regression";

test("every held-out case matches its committed hash", () => {
  const report = verifyHoldoutIntegrity();
  assert.deepEqual(report.mutated, [], "a held-out expectation was changed");
  assert.deepEqual(report.removed, [], "a held-out case was removed");
  assert.deepEqual(
    report.unregistered,
    [],
    "a held-out case is missing from the manifest — add its printed hash in the same commit",
  );
  assert.deepEqual(report.duplicateIds, []);
  assert.equal(report.ok, true);
});

test("assertHoldoutIntegrity does not throw for the committed set", () => {
  assert.doesNotThrow(() => assertHoldoutIntegrity());
});

test("the set is deep-frozen against in-memory tampering", () => {
  assert.throws(() => {
    (HOLDOUT_SET as RegressionCase[])[0]!.expectedControlFlowDepth = 99;
  });
  assert.throws(() => {
    (HOLDOUT_SET as RegressionCase[]).push({} as RegressionCase);
  });
});

test("held-out ids never collide with the main evaluation set", () => {
  const mainIds = new Set(EVAL_SET.map((c) => c.id));
  for (const c of HOLDOUT_SET) {
    assert.ok(!mainIds.has(c.id), `${c.id} appears in both sets`);
  }
});

test("a mutated case is detected", () => {
  const tampered: RegressionCase = {
    ...HOLDOUT_SET[0]!,
    expectedControlFlowDepth: HOLDOUT_SET[0]!.expectedControlFlowDepth + 1,
  };
  const report = verifyHoldoutIntegrity([tampered], HOLDOUT_MANIFEST);
  assert.equal(report.ok, false);
  assert.equal(report.mutated.length, 1);
  assert.equal(report.mutated[0]!.id, tampered.id);
});

test("a removed case is detected", () => {
  const report = verifyHoldoutIntegrity(HOLDOUT_SET.slice(1), HOLDOUT_MANIFEST);
  assert.equal(report.ok, false);
  assert.deepEqual(report.removed, [HOLDOUT_SET[0]!.id]);
});

test("an unregistered case is reported with the hash to commit", () => {
  const added: RegressionCase = { ...HOLDOUT_SET[0]!, id: "HO-999" };
  const report = verifyHoldoutIntegrity([...HOLDOUT_SET, added], HOLDOUT_MANIFEST);
  assert.equal(report.ok, false);
  assert.equal(report.unregistered.length, 1);
  assert.equal(report.unregistered[0]!.id, "HO-999");
  assert.equal(report.unregistered[0]!.hash, hashCase(added));
});

test("the fingerprint is stable and changes when a case changes", () => {
  assert.equal(holdoutFingerprint(), holdoutFingerprint());
  const tampered: RegressionCase = { ...HOLDOUT_SET[0]!, description: "different" };
  assert.notEqual(
    holdoutFingerprint(),
    holdoutFingerprint([tampered, ...HOLDOUT_SET.slice(1)]),
  );
});

test("the set covers breadth the main set does not — flat, single, and nested depths", () => {
  const depths = new Set(HOLDOUT_SET.map((c) => c.expectedControlFlowDepth));
  assert.ok(depths.has(0), "no flat (depth 0) case");
  assert.ok(depths.has(1), "no single-level case");
  assert.ok(depths.has(2), "no nested case");
  assert.ok(HOLDOUT_SET.length >= 6, "held-out set is too small to measure generalisation");
});

test("every case declares a checklist, a sequence, and assertions", () => {
  for (const c of HOLDOUT_SET) {
    assert.ok(c.intentChecklist.length > 0, `${c.id} has no checklist`);
    assert.ok(c.assertions.length > 0, `${c.id} has no assertions`);

    if (c.mustRefuse === true) {
      // A must-refuse case has no expected output by definition. Requiring a
      // sequence here would force a meaningless one to be invented, and the
      // harness ignores the field for these cases anyway.
      assert.equal(
        c.expectedActionSequence.length,
        0,
        `${c.id} must refuse, so it must not declare an expected sequence`,
      );
      assert.equal(c.expectedControlFlowDepth, 0, `${c.id} must refuse; depth must be 0`);
    } else {
      assert.ok(c.expectedActionSequence.length > 0, `${c.id} has no expected sequence`);
    }
  }
});

test("the set measures refusal, not only construction", () => {
  // Without a must-refuse case, a variant that improved purely by guessing more
  // confidently would score better on every case in the suite.
  const refusals = HOLDOUT_SET.filter((c) => c.mustRefuse === true);
  assert.ok(refusals.length > 0, "held-out set cannot detect over-eager generation");
});

test("held-out descriptions are not thin", () => {
  for (const c of HOLDOUT_SET) {
    // Must-refuse cases are deliberately terse — an under-specified request is
    // the thing being tested — so they are held to a lower bound only.
    const floor = c.mustRefuse === true ? 5 : 20;
    assert.ok(
      c.description.trim().length > floor,
      `${c.id} description is too thin (${c.description.trim().length} chars)`,
    );
  }
});
