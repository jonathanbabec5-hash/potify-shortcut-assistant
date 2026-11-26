import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVAL_SET,
  EVAL_SET_MANIFEST,
  EvalSetIntegrityError,
  assertEvalSetIntegrity,
  evalSetFingerprint,
  hashCase,
  verifyEvalSetIntegrity,
} from './eval-set';
import type { RegressionCase } from '../shortcuts/regression';

function cloneCase(c: RegressionCase): RegressionCase {
  return JSON.parse(JSON.stringify(c)) as RegressionCase;
}

// ─────────────────────────────────────────────────────────────────────────────
// The live tripwire
// ─────────────────────────────────────────────────────────────────────────────

test('the committed evaluation set matches its manifest', () => {
  const report = verifyEvalSetIntegrity();
  if (!report.ok) {
    // Print the hashes so the fix is copy-pasteable — while still failing.
    const detail = [
      ...report.mutated.map((m) => `MUTATED ${m.id}: manifest ${m.expected}, actual ${m.actual}`),
      ...report.unregistered.map((u) => `UNREGISTERED ${u.id}: add "${u.id}": "${u.hash}"`),
      ...report.removed.map((id) => `REMOVED ${id}`),
      ...report.duplicateIds.map((id) => `DUPLICATE ${id}`),
    ].join('\n');
    assert.fail(
      `Evaluation set integrity failed. An eval case is the specification a ` +
        `candidate is measured against — do not edit one to make a run pass.\n${detail}`,
    );
  }
  assert.equal(report.ok, true);
});

test('assertEvalSetIntegrity passes for the committed set', () => {
  assert.doesNotThrow(() => assertEvalSetIntegrity());
});

test('the manifest is not empty and covers every case', () => {
  assert.ok(EVAL_SET.length > 0);
  assert.equal(Object.keys(EVAL_SET_MANIFEST).length, EVAL_SET.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime immutability
// ─────────────────────────────────────────────────────────────────────────────

test('the evaluation set is deep-frozen', () => {
  assert.ok(Object.isFrozen(EVAL_SET));
  const first = EVAL_SET[0]!;
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.expectedActionSequence));
  assert.ok(Object.isFrozen(first.intentChecklist));
  assert.ok(Object.isFrozen(first.assertions));
});

test('mutating a case at runtime throws', () => {
  const first = EVAL_SET[0]! as RegressionCase;
  assert.throws(() => {
    (first as { description: string }).description = 'something easier';
  }, TypeError);
  assert.throws(() => {
    (first.expectedActionSequence as string[]).push('is.workflow.actions.comment');
  }, TypeError);
});

test('the set cannot be extended at runtime', () => {
  assert.throws(() => {
    (EVAL_SET as RegressionCase[]).push(cloneCase(EVAL_SET[0]!));
  }, TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// Detection of tampering
// ─────────────────────────────────────────────────────────────────────────────

test('editing a registered expectation is reported as mutation', () => {
  const tampered = cloneCase(EVAL_SET[0]!);
  tampered.expectedControlFlowDepth = 1; // was 3 — makes the hard case easy
  const report = verifyEvalSetIntegrity([tampered], EVAL_SET_MANIFEST);
  assert.equal(report.ok, false);
  assert.equal(report.mutated.length, 1);
  assert.equal(report.mutated[0]!.id, tampered.id);
});

test('weakening an assertion is reported as mutation', () => {
  const tampered = cloneCase(EVAL_SET[0]!);
  tampered.assertions = tampered.assertions.slice(0, 1);
  const report = verifyEvalSetIntegrity([tampered], EVAL_SET_MANIFEST);
  assert.equal(report.ok, false);
  assert.equal(report.mutated.length, 1);
});

test('deleting a case is reported as removal', () => {
  const report = verifyEvalSetIntegrity([], EVAL_SET_MANIFEST);
  assert.equal(report.ok, false);
  assert.deepEqual(report.removed, Object.keys(EVAL_SET_MANIFEST));
});

test('a new case is reported as unregistered with the hash to commit', () => {
  const added = cloneCase(EVAL_SET[0]!);
  added.id = 'RC-999';
  const report = verifyEvalSetIntegrity([...EVAL_SET, added], EVAL_SET_MANIFEST);
  assert.equal(report.ok, false);
  assert.equal(report.unregistered.length, 1);
  assert.equal(report.unregistered[0]!.id, 'RC-999');
  assert.equal(report.unregistered[0]!.hash, hashCase(added));
});

test('a reused id is reported', () => {
  const duplicate = cloneCase(EVAL_SET[0]!);
  const report = verifyEvalSetIntegrity([...EVAL_SET, duplicate], EVAL_SET_MANIFEST);
  assert.equal(report.ok, false);
  assert.deepEqual(report.duplicateIds, [duplicate.id]);
});

test('EvalSetIntegrityError explains how to fix an unregistered case', () => {
  const added = cloneCase(EVAL_SET[0]!);
  added.id = 'RC-998';
  const report = verifyEvalSetIntegrity([added], {});
  const err = new EvalSetIntegrityError(report);
  assert.match(err.message, /EVAL_SET_MANIFEST/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

test('the fingerprint is stable and order-independent', () => {
  assert.equal(evalSetFingerprint(), evalSetFingerprint());
  const reversed = [...EVAL_SET].reverse();
  assert.equal(evalSetFingerprint(reversed), evalSetFingerprint());
});

test('the fingerprint changes when a case changes', () => {
  const tampered = cloneCase(EVAL_SET[0]!);
  tampered.expectedControlFlowDepth = 1;
  assert.notEqual(evalSetFingerprint([tampered]), evalSetFingerprint());
});
