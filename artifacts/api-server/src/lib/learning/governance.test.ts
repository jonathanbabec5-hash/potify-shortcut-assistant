import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMOTION_GATES,
  GovernanceViolationError,
  assertArtifactsUnchanged,
  compareFingerprints,
  evaluatePromotion,
  fingerprintArtifacts,
  isRollbackPlanUsable,
  type GateResult,
  type PromotionGateId,
} from './governance';

const NOW = 1_800_000_000_000;

const BASE = {
  catalogVersion: '1',
  catalogJson: '{"actions":[]}',
  promptPolicy: 'you are a shortcuts builder',
  now: NOW,
};

// ─────────────────────────────────────────────────────────────────────────────
// A. Production artifacts cannot change under a running process
// ─────────────────────────────────────────────────────────────────────────────

test('the same inputs always produce the same fingerprint', () => {
  const a = fingerprintArtifacts(BASE);
  const b = fingerprintArtifacts({ ...BASE, now: NOW + 5000 });
  assert.equal(a.catalogHash, b.catalogHash);
  assert.equal(a.systemPromptHash, b.systemPromptHash);
});

test('a changed catalog is detected', () => {
  const baseline = fingerprintArtifacts(BASE);
  const current = fingerprintArtifacts({ ...BASE, catalogJson: '{"actions":[1]}' });
  const report = compareFingerprints(baseline, current);
  assert.equal(report.ok, false);
  assert.ok(report.drifted.includes('catalogHash'));
});

test('a changed system prompt is detected', () => {
  const baseline = fingerprintArtifacts(BASE);
  const current = fingerprintArtifacts({ ...BASE, promptPolicy: 'you are something else' });
  assert.ok(compareFingerprints(baseline, current).drifted.includes('systemPromptHash'));
});

test('assertArtifactsUnchanged throws and names what drifted', () => {
  const baseline = fingerprintArtifacts(BASE);
  const current = fingerprintArtifacts({ ...BASE, catalogVersion: '2', catalogJson: '{}' });
  assert.throws(
    () => assertArtifactsUnchanged(baseline, current),
    (err: unknown) => {
      assert.ok(err instanceof GovernanceViolationError);
      assert.ok(err.drifted.includes('catalogVersion'));
      assert.ok(err.drifted.includes('catalogHash'));
      assert.match(err.message, /live self-modification/i);
      return true;
    },
  );
});

test('an unchanged process passes the integrity check', () => {
  const baseline = fingerprintArtifacts(BASE);
  assert.doesNotThrow(() => assertArtifactsUnchanged(baseline, fingerprintArtifacts(BASE)));
});

test('the fingerprint is frozen', () => {
  assert.ok(Object.isFrozen(fingerprintArtifacts(BASE)));
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Promotion is fail-closed
// ─────────────────────────────────────────────────────────────────────────────

function pass(gate: PromotionGateId): GateResult {
  return { gate, passed: true, detail: 'ok', evaluatedAt: NOW };
}
function fail(gate: PromotionGateId): GateResult {
  return { gate, passed: false, detail: 'regressed', evaluatedAt: NOW };
}
function allPassing(): GateResult[] {
  return PROMOTION_GATES.map(pass);
}

test('the gate list is frozen and includes human approval', () => {
  assert.ok(Object.isFrozen(PROMOTION_GATES));
  assert.ok(PROMOTION_GATES.includes('human-approval'));
  assert.ok(PROMOTION_GATES.includes('rollback-plan'));
  assert.ok(PROMOTION_GATES.includes('champion-challenger'));
  assert.ok(PROMOTION_GATES.includes('privacy-safety-review'));
});

test('a candidate with every gate passing is approved', () => {
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results: allPassing() },
    NOW,
  );
  assert.equal(decision.approved, true);
  assert.deepEqual(decision.failed, []);
  assert.deepEqual(decision.missing, []);
});

test('a single failing gate blocks promotion', () => {
  const results = allPassing().filter((r) => r.gate !== 'regression').concat(fail('regression'));
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results },
    NOW,
  );
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.failed, ['regression']);
});

test('a gate that was never evaluated blocks exactly like a failure', () => {
  const results = allPassing().filter((r) => r.gate !== 'human-approval');
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results },
    NOW,
  );
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.missing, ['human-approval']);
});

test('an empty result set blocks on every gate', () => {
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results: [] },
    NOW,
  );
  assert.equal(decision.approved, false);
  assert.equal(decision.missing.length, PROMOTION_GATES.length);
});

test('conflicting verdicts for one gate block promotion', () => {
  const results = allPassing().concat(fail('benchmark-improvement'));
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results },
    NOW,
  );
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.conflicted, ['benchmark-improvement']);
});

test('an unrecognised gate carries no authority', () => {
  const results = allPassing()
    .filter((r) => r.gate !== 'human-approval')
    .concat({
      gate: 'rubber-stamp' as PromotionGateId,
      passed: true,
      detail: 'looks fine to me',
      evaluatedAt: NOW,
    });
  const decision = evaluatePromotion(
    { candidateId: 'cand-2', championId: 'champ-1', results },
    NOW,
  );
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.missing, ['human-approval']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rollback
// ─────────────────────────────────────────────────────────────────────────────

test('a rollback plan needs a target, a trigger metric, and a threshold', () => {
  assert.equal(isRollbackPlanUsable(null), false);
  assert.equal(
    isRollbackPlanUsable({
      revertTo: '',
      method: 'redeploy',
      triggerMetric: 'readyRate',
      triggerThreshold: 0.9,
      recordedAt: NOW,
    }),
    false,
  );
  assert.equal(
    isRollbackPlanUsable({
      revertTo: 'champ-1',
      method: 'config-flag',
      triggerMetric: 'readyRate',
      triggerThreshold: 0.9,
      recordedAt: NOW,
    }),
    true,
  );
});
