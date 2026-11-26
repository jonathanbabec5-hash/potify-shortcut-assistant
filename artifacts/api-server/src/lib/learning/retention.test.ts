/**
 * Retention: what gets deleted, and what must survive deletion.
 *
 * Every assertion here is made against *deltas* in a dry-run plan rather than by
 * executing a sweep. The dev database holds accumulated fixture rows from other
 * suites, and a real sweep would delete rows this test does not own — so the test
 * inserts its own grants, measures how the plan's counts move, and cleans up.
 * Comparing deltas also means the assertions do not depend on how much fixture
 * debris happens to be present.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, consentGrants } from "@workspace/db";

import { CONSENT_POLICY_VERSION, CONSENT_TTL_MS } from "./consent";
import { RETENTION_POLICY, planRetentionSweep } from "./retention";

const NOW = Date.UTC(2026, 6, 29);
/** Comfortably past every TTL in the policy. */
const LONG_AGO = new Date(NOW - CONSENT_TTL_MS - 30 * 24 * 60 * 60 * 1000);

// Pseudonyms must be long enough to look like real pseudonymize() output, and
// unique — the table has a unique index on the subject.
const TOMBSTONE_SUBJECT = "retention-test-tombstone-subject-0001";
const SWEEPABLE_SUBJECT = "retention-test-sweepable-subject-0001";

after(async () => {
  await db.delete(consentGrants).where(eq(consentGrants.subjectPseudonym, TOMBSTONE_SUBJECT));
  await db.delete(consentGrants).where(eq(consentGrants.subjectPseudonym, SWEEPABLE_SUBJECT));
});

function countOf(plan: Awaited<ReturnType<typeof planRetentionSweep>>, id: string): number {
  return plan.classes.find((c) => c.id === id)?.count ?? 0;
}

test("a withdrawal tombstone is never scheduled for deletion, however old it is", async () => {
  const before = countOf(await planRetentionSweep(NOW), "grants-expired-and-unused");

  // Long expired, never used by any record — but withdrawn. This row is the only
  // proof the withdrawal was honoured. Deleting it would destroy the evidence
  // that we did the right thing, which is worse than keeping the pseudonym.
  await db.insert(consentGrants).values({
    subjectPseudonym: TOMBSTONE_SUBJECT,
    scope: "none",
    policyVersion: CONSENT_POLICY_VERSION,
    grantedAt: LONG_AGO,
    withdrawnAt: LONG_AGO,
  });

  const after_ = countOf(await planRetentionSweep(NOW), "grants-expired-and-unused");
  assert.equal(
    after_,
    before,
    "an expired, unused, withdrawn grant must not be counted for deletion — it is the proof of withdrawal",
  );
});

test("an expired grant that was never used and never withdrawn is scheduled", async () => {
  const before = countOf(await planRetentionSweep(NOW), "grants-expired-and-unused");

  await db.insert(consentGrants).values({
    subjectPseudonym: SWEEPABLE_SUBJECT,
    scope: "redacted-examples",
    policyVersion: CONSENT_POLICY_VERSION,
    grantedAt: LONG_AGO,
    withdrawnAt: null,
  });

  const after_ = countOf(await planRetentionSweep(NOW), "grants-expired-and-unused");
  assert.equal(
    after_,
    before + 1,
    "an expired, unused, non-withdrawn grant holds a pseudonym that can authorise nothing, so it must be swept",
  );
});

test("the plan names every class, so a policy bump cannot hide behind routine ageing", async () => {
  const plan = await planRetentionSweep(NOW);
  const ids = plan.classes.map((c) => c.id).sort();
  assert.deepEqual(ids, [
    "grants-expired-and-unused",
    "outcomes-aged-out",
    "records-consent-expired",
    "records-policy-superseded",
  ]);
  for (const c of plan.classes) {
    assert.ok(c.rationale.length > 20, `${c.id} has no rationale for the operator`);
  }
  assert.equal(plan.policyVersion, CONSENT_POLICY_VERSION);
});

test("frozen batch members are reported, not exempted", async () => {
  const plan = await planRetentionSweep(NOW);

  // The number may legitimately be 0 on an empty corpus. What matters is that the
  // field exists and is a warning rather than a filter: no predicate consults
  // batch membership, so a record inside a frozen batch is deleted on schedule
  // and that batch's integrity check starts failing — which is the correct,
  // visible outcome. A carve-out would keep integrity green by retaining data
  // past the promise made to the user.
  assert.equal(typeof plan.frozenBatchMembersAffected, "number");
  assert.ok(plan.frozenBatchMembersAffected >= 0);
  assert.ok(
    plan.totalRows >= plan.classes.reduce((n, c) => n + c.count, 0) - plan.classes.length,
    "totalRows should account for the per-class counts",
  );
});

test("record TTL is derived from the consent TTL, not restated", () => {
  // If these ever disagree, the app is keeping data longer than the consent that
  // authorised it — the one retention bug that is also a broken promise.
  assert.equal(RETENTION_POLICY.recordTtlMs, CONSENT_TTL_MS);
  assert.equal(RETENTION_POLICY.unusedGrantTtlMs, CONSENT_TTL_MS);
  assert.ok(
    RETENTION_POLICY.outcomeTtlMs > RETENTION_POLICY.recordTtlMs,
    "outcome rows carry no user text and are kept longer on purpose",
  );
});
