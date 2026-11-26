import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSENT_POLICY_VERSION,
  CONSENT_TTL_MS,
  NO_CONSENT,
  ConsentError,
  assertCollectionAllowed,
  evaluateConsent,
  grantConsent,
  isCollectionScope,
  mayCollect,
  withdrawConsent,
  describeScope,
  ALL_SCOPES,
  type ConsentRecord,
} from './consent';

const NOW = 1_800_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Default deny
// ─────────────────────────────────────────────────────────────────────────────

test('the default record refuses every collecting scope', () => {
  for (const scope of ALL_SCOPES) {
    if (scope === 'none') continue;
    assert.equal(mayCollect(NO_CONSENT, scope, NOW), false, `must refuse ${scope}`);
  }
});

test('absent consent refuses with "no-grant", not a silent false', () => {
  const decision = evaluateConsent(undefined, 'outcomes-only', NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, 'no-grant');
});

test('null consent is refused', () => {
  assert.equal(mayCollect(null, 'outcomes-only', NOW), false);
});

test('retaining nothing needs no consent', () => {
  assert.equal(mayCollect(NO_CONSENT, 'none', NOW), true);
  assert.equal(mayCollect(null, 'none', NOW), true);
});

test('NO_CONSENT is frozen so it cannot be widened in place', () => {
  assert.ok(Object.isFrozen(NO_CONSENT));
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope ordering
// ─────────────────────────────────────────────────────────────────────────────

test('a grant covers its own scope and everything narrower', () => {
  const consent = grantConsent('redacted-examples', 'pseudo-1', NOW);
  assert.equal(mayCollect(consent, 'outcomes-only', NOW), true);
  assert.equal(mayCollect(consent, 'redacted-examples', NOW), true);
});

test('a grant never implies a wider scope', () => {
  const consent = grantConsent('outcomes-only', 'pseudo-1', NOW);
  const decision = evaluateConsent(consent, 'redacted-examples', NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, 'scope-too-narrow');
});

test('granting "none" produces no grant timestamp', () => {
  const consent = grantConsent('none', 'pseudo-1', NOW);
  assert.equal(consent.grantedAt, null);
  assert.equal(mayCollect(consent, 'outcomes-only', NOW), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Policy versioning and expiry
// ─────────────────────────────────────────────────────────────────────────────

test('consent given under a superseded policy is refused', () => {
  const stale: ConsentRecord = {
    scope: 'full-examples',
    policyVersion: '2020-01-01.1',
    grantedAt: NOW,
    subjectPseudonym: 'pseudo-1',
  };
  const decision = evaluateConsent(stale, 'outcomes-only', NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, 'policy-superseded');
  assert.match(decision.detail, new RegExp(CONSENT_POLICY_VERSION));
});

test('consent expires and is then treated as withdrawn', () => {
  const consent = grantConsent('full-examples', 'pseudo-1', NOW);
  assert.equal(mayCollect(consent, 'full-examples', NOW + CONSENT_TTL_MS - 1), true);
  const decision = evaluateConsent(consent, 'full-examples', NOW + CONSENT_TTL_MS + 1);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, 'expired');
});

test('withdrawal takes effect immediately', () => {
  const consent = grantConsent('full-examples', 'pseudo-1', NOW);
  const withdrawn = withdrawConsent(consent);
  assert.equal(mayCollect(withdrawn, 'outcomes-only', NOW), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed records — a corrupt record must never out-rank a valid refusal
// ─────────────────────────────────────────────────────────────────────────────

test('an unrecognised scope is refused, not silently ranked as sufficient', () => {
  // SCOPE_RANK["garbage"] is undefined and `undefined < n` is false, so an
  // unguarded rank comparison would ALLOW this.
  const corrupt = {
    scope: 'garbage',
    policyVersion: CONSENT_POLICY_VERSION,
    grantedAt: NOW,
    subjectPseudonym: 'pseudo-1',
  } as unknown as ConsentRecord;

  for (const required of ALL_SCOPES) {
    if (required === 'none') continue;
    const decision = evaluateConsent(corrupt, required, NOW);
    assert.equal(decision.allowed, false, `must refuse a corrupt scope for ${required}`);
    assert.equal(decision.refusal, 'malformed');
  }
});

test('an unrecognised required scope is refused rather than guessed', () => {
  const consent = grantConsent('full-examples', 'pseudo-1', NOW);
  const decision = evaluateConsent(consent, 'everything' as never, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, 'malformed');
});

test('a grant with no subject cannot be honoured — it could never be revoked', () => {
  for (const subject of ['', undefined, null, 42]) {
    const orphan = {
      scope: 'full-examples',
      policyVersion: CONSENT_POLICY_VERSION,
      grantedAt: NOW,
      subjectPseudonym: subject,
    } as unknown as ConsentRecord;
    const decision = evaluateConsent(orphan, 'outcomes-only', NOW);
    assert.equal(decision.allowed, false, `must refuse subject ${String(subject)}`);
    assert.equal(decision.refusal, 'malformed');
  }
});

test('isCollectionScope only recognises the declared scopes', () => {
  for (const scope of ALL_SCOPES) assert.equal(isCollectionScope(scope), true);
  for (const junk of ['garbage', '', null, undefined, 0, {}, 'NONE', 'toString']) {
    assert.equal(isCollectionScope(junk), false, `must reject ${String(junk)}`);
  }
});

test('a malformed record is refused by the hard gate too', () => {
  const corrupt = {
    scope: 'garbage',
    policyVersion: CONSENT_POLICY_VERSION,
    grantedAt: NOW,
    subjectPseudonym: 'pseudo-1',
  } as unknown as ConsentRecord;
  assert.throws(() => assertCollectionAllowed(corrupt, 'outcomes-only', NOW), ConsentError);
  assert.equal(mayCollect(corrupt, 'outcomes-only', NOW), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The hard gate
// ─────────────────────────────────────────────────────────────────────────────

test('assertCollectionAllowed throws rather than returning false', () => {
  assert.throws(
    () => assertCollectionAllowed(NO_CONSENT, 'redacted-examples', NOW),
    (err: unknown) => {
      assert.ok(err instanceof ConsentError);
      assert.equal(err.refusal, 'no-grant');
      return true;
    },
  );
});

test('assertCollectionAllowed passes for a valid grant', () => {
  const consent = grantConsent('redacted-examples', 'pseudo-1', NOW);
  assert.doesNotThrow(() => assertCollectionAllowed(consent, 'redacted-examples', NOW));
});

test('every scope has user-facing copy', () => {
  for (const scope of ALL_SCOPES) {
    assert.ok(describeScope(scope).length > 20, `missing copy for ${scope}`);
  }
});
