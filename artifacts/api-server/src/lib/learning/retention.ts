/**
 * Retention and deletion schedule for consented learning data.
 *
 * ## Why this is a safeguard and not housekeeping
 *
 * Consent expires (`CONSENT_TTL_MS`) and is bound to a policy version. Both
 * facts were enforced at the *collection* boundary and nowhere else, so a record
 * collected under valid consent stayed in the corpus permanently: the grant
 * silently aged out, the policy silently moved on, and nothing ever went back to
 * remove what those changes had de-authorised. "You may keep this for 180 days"
 * with no deletion path is not a retention policy, it is an intention.
 *
 * `candidate.ts` now refuses to *train* on such records. This module removes
 * them, which is the other half — refusing to use data is not the same as not
 * holding it.
 *
 * ## Design constraints, and why each one
 *
 *  - **On demand, never a timer.** This deployment is autoscale with an
 *    ephemeral filesystem; containers start and stop constantly. An in-process
 *    `setInterval` would run an unbounded number of concurrent sweeps across
 *    replicas, or none at all if no container happened to be up. Deletion runs
 *    when an operator runs it.
 *  - **Dry run by default.** `execute` must be asked for explicitly. The
 *    expensive mistake here is unrecoverable, so the default is the safe one.
 *  - **Idempotent.** Every predicate is absolute — a timestamp threshold or a
 *    policy-version equality — never "the next N rows". Running twice deletes
 *    nothing the second time; running after a crash resumes correctly.
 *  - **Counts only in output.** No ids, pseudonyms, or text ever leave this
 *    module. A retention log that quotes the data it deleted defeats itself.
 *  - **Withdrawal tombstones are never deleted.** A `consent_grants` row with
 *    `withdrawn_at` set is the proof that a withdrawal was honoured. Deleting it
 *    would make withdrawal unprovable, so it is excluded from every class here —
 *    permanently, not just until it ages.
 *
 * ## Retention deliberately beats batch stability
 *
 * A record inside a frozen training batch is deleted like any other. It is not
 * exempted, and the batch is not quietly repaired. `verifyBatchIntegrity`
 * already reports it as a missing member and `buildCandidate` refuses to treat
 * the batch as the reviewed set. That is the correct outcome: an expired record
 * must leave, and the resulting batch really is no longer what a human approved.
 * The sweep reports how many frozen members it will affect so that consequence
 * is visible before it happens, not discovered afterwards.
 */

import { and, count, eq, isNull, lt, ne, notExists } from "drizzle-orm";
import {
  db,
  consentGrants,
  interactionRecords,
  runOutcomes,
  trainingBatchMembers,
} from "@workspace/db";

import { CONSENT_POLICY_VERSION, CONSENT_TTL_MS } from "./consent";

// ── Schedule ──────────────────────────────────────────────────────────────────

export const RETENTION_POLICY = Object.freeze({
  /**
   * Interaction records live exactly as long as the consent that authorised
   * them. Deriving this from `CONSENT_TTL_MS` rather than restating a number
   * means the two cannot drift into disagreeing about the promise made to the
   * user.
   */
  recordTtlMs: CONSENT_TTL_MS,

  /**
   * Outcome rows hold no user text at all — pass/fail, counts, token cost,
   * provenance — so they are kept longer to make year-over-year comparison
   * possible. They still carry a pseudonym, so they are not kept forever.
   * 400 days.
   */
  outcomeTtlMs: 400 * 24 * 60 * 60 * 1000,

  /**
   * An expired grant that never produced a record, and was never withdrawn.
   * Nothing references it and it cannot authorise anything, so the pseudonym it
   * holds is pure liability.
   */
  unusedGrantTtlMs: CONSENT_TTL_MS,
});

export type RetentionClassId =
  | "records-consent-expired"
  | "records-policy-superseded"
  | "outcomes-aged-out"
  | "grants-expired-and-unused";

export interface RetentionClass {
  id: RetentionClassId;
  /** Shown to the operator. Explains the rule, not the row. */
  rationale: string;
  count: number;
}

export interface RetentionSweepPlan {
  now: number;
  policyVersion: string;
  classes: RetentionClass[];
  totalRows: number;
  /**
   * Frozen training-batch members among the records due for deletion.
   *
   * Not a blocker and not an exemption — a warning that batch integrity will
   * legitimately start failing for those batches once the sweep runs.
   */
  frozenBatchMembersAffected: number;
}

export interface RetentionSweepResult extends RetentionSweepPlan {
  dryRun: boolean;
  /** Rows actually deleted, by class. All zero when `dryRun`. */
  deleted: Record<RetentionClassId, number>;
}

// ── Predicates ────────────────────────────────────────────────────────────────
//
// Defined once and shared by the planner and the executor, so a dry run cannot
// describe a different set of rows than the one execution removes.

function recordsConsentExpired(now: number) {
  return lt(interactionRecords.consentGrantedAt, new Date(now - RETENTION_POLICY.recordTtlMs));
}

function recordsPolicySuperseded() {
  return ne(interactionRecords.policyVersion, CONSENT_POLICY_VERSION);
}

function outcomesAgedOut(now: number) {
  return lt(runOutcomes.measuredAt, new Date(now - RETENTION_POLICY.outcomeTtlMs));
}

/**
 * Expired, never withdrawn, and no longer referenced by any record.
 *
 * The `notExists` clause is what makes sweep order safe: records are deleted
 * first, so by the time grants are considered, a subject whose records have just
 * been removed correctly qualifies — and a subject whose records are still
 * within their TTL keeps its grant, so nothing is left orphaned from the consent
 * that authorised it.
 */
function grantsExpiredAndUnused(now: number) {
  return and(
    isNull(consentGrants.withdrawnAt),
    lt(consentGrants.grantedAt, new Date(now - RETENTION_POLICY.unusedGrantTtlMs)),
    notExists(
      db
        .select({ one: interactionRecords.id })
        .from(interactionRecords)
        .where(eq(interactionRecords.subjectPseudonym, consentGrants.subjectPseudonym)),
    ),
  );
}

// ── Plan ──────────────────────────────────────────────────────────────────────

const rowCount = (rows: Array<{ n: number }>): number => Number(rows[0]?.n ?? 0);

export async function planRetentionSweep(now: number = Date.now()): Promise<RetentionSweepPlan> {
  // Counted per class rather than as one grand total, so a dry run tells the
  // operator *which* rule is about to remove data. A single number would hide a
  // policy bump wiping the corpus behind what looks like routine ageing.
  const [expiredRows, supersededRows, agedRows, unusedRows] = await Promise.all([
    db.select({ n: count() }).from(interactionRecords).where(recordsConsentExpired(now)),
    db.select({ n: count() }).from(interactionRecords).where(recordsPolicySuperseded()),
    db.select({ n: count() }).from(runOutcomes).where(outcomesAgedOut(now)),
    db.select({ n: count() }).from(consentGrants).where(grantsExpiredAndUnused(now)),
  ]);

  const expiredRecords = rowCount(expiredRows);
  const supersededRecords = rowCount(supersededRows);
  const agedOutcomes = rowCount(agedRows);
  const unusedGrants = rowCount(unusedRows);

  // How much frozen-batch damage this sweep will cause, counted before it does.
  const frozenRows = await db
    .select({ n: count() })
    .from(trainingBatchMembers)
    .innerJoin(interactionRecords, eq(trainingBatchMembers.recordId, interactionRecords.id))
    .where(recordsConsentExpired(now));

  const classes: RetentionClass[] = [
    {
      id: "records-consent-expired",
      rationale: `Consent older than ${Math.round(RETENTION_POLICY.recordTtlMs / 86_400_000)} days is treated as withdrawn, so the record may no longer be held.`,
      count: expiredRecords,
    },
    {
      id: "records-policy-superseded",
      rationale: `Collected under a policy other than ${CONSENT_POLICY_VERSION}; the grant was invalidated by the policy bump and cannot authorise continued retention or any future use.`,
      count: supersededRecords,
    },
    {
      id: "outcomes-aged-out",
      rationale: `Derived metrics with no user text, past their ${Math.round(RETENTION_POLICY.outcomeTtlMs / 86_400_000)}-day retention.`,
      count: agedOutcomes,
    },
    {
      id: "grants-expired-and-unused",
      rationale:
        "Expired, never withdrawn, and no record references the subject. Withdrawal tombstones are never included.",
      count: unusedGrants,
    },
  ];

  return {
    now,
    policyVersion: CONSENT_POLICY_VERSION,
    classes,
    totalRows: classes.reduce((n, c) => n + c.count, 0),
    frozenBatchMembersAffected: Number(frozenRows[0]?.n ?? 0),
  };
}

// ── Execute ───────────────────────────────────────────────────────────────────

export interface SweepOptions {
  now?: number;
  /**
   * Deletion happens only when this is explicitly `false`.
   *
   * Defaulting to a dry run means a caller that forgets the flag, or a future
   * refactor that drops it, plans instead of deletes. The failure mode of the
   * default is a wasted query.
   */
  dryRun?: boolean;
}

export async function executeRetentionSweep(
  options: SweepOptions = {},
): Promise<RetentionSweepResult> {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun !== false;

  const plan = await planRetentionSweep(now);

  const deleted: Record<RetentionClassId, number> = {
    "records-consent-expired": 0,
    "records-policy-superseded": 0,
    "outcomes-aged-out": 0,
    "grants-expired-and-unused": 0,
  };

  if (dryRun) return { ...plan, dryRun: true, deleted };

  // Order matters. Records go first so `grants-expired-and-unused` sees the
  // post-deletion state and a grant is never removed while a record still
  // depends on it for its provenance.
  const expired = await db
    .delete(interactionRecords)
    .where(recordsConsentExpired(now))
    .returning({ id: interactionRecords.id });
  deleted["records-consent-expired"] = expired.length;

  const superseded = await db
    .delete(interactionRecords)
    .where(recordsPolicySuperseded())
    .returning({ id: interactionRecords.id });
  deleted["records-policy-superseded"] = superseded.length;

  const outcomes = await db
    .delete(runOutcomes)
    .where(outcomesAgedOut(now))
    .returning({ id: runOutcomes.id });
  deleted["outcomes-aged-out"] = outcomes.length;

  const grants = await db
    .delete(consentGrants)
    .where(grantsExpiredAndUnused(now))
    .returning({ id: consentGrants.id });
  deleted["grants-expired-and-unused"] = grants.length;

  return { ...plan, dryRun: false, deleted };
}

/**
 * Counts-only summary, safe to log or return over the operator endpoint.
 *
 * Deliberately has no parameter for including examples of what was deleted. The
 * point of retention is that the data is gone; quoting it in a report keeps a
 * copy in the logs.
 */
export function describeSweep(result: RetentionSweepResult): string {
  const lines = result.classes.map(
    (c) =>
      `  ${c.id.padEnd(28)} due=${String(c.count).padStart(6)}  deleted=${String(
        result.deleted[c.id],
      ).padStart(6)}`,
  );
  const mode = result.dryRun ? "DRY RUN (nothing deleted)" : "EXECUTED";
  const frozen =
    result.frozenBatchMembersAffected > 0
      ? `\n  ⚠ ${result.frozenBatchMembersAffected} frozen batch member(s) affected — ` +
        "those batches will now fail integrity verification, which is correct: they are " +
        "no longer the set a human reviewed."
      : "";
  return `${mode} — policy ${result.policyVersion}, ${result.totalRows} row(s) due\n${lines.join("\n")}${frozen}`;
}
