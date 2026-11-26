/**
 * Controlled training batches.
 *
 * ⚠️  Offline only. Nothing in the request path may import this module — see
 *     `training-isolation.test.ts`, which fails the build if anything does.
 *
 * A batch is the unit of "learning" in this system. It exists so that training
 * is a discrete, reviewable, reproducible event rather than a continuous drift.
 * Three properties make that true:
 *
 *  - **Frozen membership.** Members are recorded at freeze time. The batch
 *    cannot silently grow as new examples arrive.
 *  - **Content hashes.** Each member's content is hashed at freeze time, so a
 *    record that later changes (late feedback rescoring it, say) is detectable
 *    rather than quietly altering what "the batch" meant.
 *  - **Recorded selection.** The exact criteria are stored, so the batch can be
 *    justified after the fact and rebuilt from the same corpus.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  interactionRecords,
  trainingBatches,
  trainingBatchMembers,
  type InteractionRecordRow,
} from "@workspace/db";

import type { CollectionScope } from "../consent";
import { evalSetFingerprint } from "../eval-set";
import type { ArtifactFingerprint } from "../governance";

/**
 * Scopes whose examples may be trained on.
 *
 * `outcomes-only` is deliberately absent: it holds no request or workflow, so
 * there is nothing to learn from, and including it would stretch what those
 * users agreed to.
 */
export const TRAINABLE_SCOPES: readonly CollectionScope[] = Object.freeze([
  "redacted-examples",
  "full-examples",
]);

/**
 * The least revealing scope that still permits training.
 *
 * Exported so eligibility is decided by `evaluateConsent(consent, this, now)` —
 * the same resolver collection uses — rather than by a second membership test
 * that would only check the scope *name* and silently ignore expiry and policy
 * version. One resolver, or the two drift apart and the weaker one wins.
 */
export const MIN_TRAINABLE_SCOPE: CollectionScope = "redacted-examples";

export interface BatchSelection {
  /** Records below this are excluded. */
  minQualityScore: number;
  maxRecords: number;
  /**
   * Restrict to examples a user confirmed ran on a device. Small, slow to
   * accumulate, and by far the highest-signal subset.
   */
  requireDeviceSuccess: boolean;
}

export const DEFAULT_SELECTION: Readonly<BatchSelection> = Object.freeze({
  minQualityScore: 0.6,
  maxRecords: 5_000,
  requireDeviceSuccess: false,
});

export interface FrozenBatch {
  id: string;
  label: string;
  memberCount: number;
  manifestHash: string;
  frozenAt: number;
  selection: BatchSelection;
  evalSetFingerprint: string;
  /** The catalog/prompt artifacts this batch was built against. */
  artifactFingerprint: ArtifactFingerprint;
}

/** Hash of the fields that define what this example teaches. */
export function contentHashOf(row: InteractionRecordRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        r: row.requestRedacted,
        w: row.workflowHash,
        v: row.validationHistory,
        e: row.userEdits,
        a: row.accepted,
        q: row.qualityScore,
      }),
    )
    .digest("hex");
}

function manifestHashOf(members: ReadonlyArray<{ recordId: string; contentHash: string }>): string {
  const sorted = [...members].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const hash = createHash("sha256");
  for (const m of sorted) hash.update(m.recordId).update(":").update(m.contentHash).update("\n");
  return hash.digest("hex");
}

/**
 * Selects eligible examples and freezes them into a batch.
 *
 * Quarantined records are excluded by the status filter and there is no option
 * to include them. Untrusted input must not be able to reach training through a
 * configuration flag.
 *
 * `artifactFingerprint` is injected rather than read from the booted server's
 * `boot.ts`, for the same reason `runBenchmark` takes an injected `CaseRunner`:
 * importing it would pull the live model client into an offline job. An offline
 * job is also not a booted web process, so borrowing that process's fingerprint
 * would have recorded the wrong thing even when it happened to be equal.
 */
export async function freezeTrainingBatch(
  label: string,
  artifactFingerprint: ArtifactFingerprint,
  selection: Partial<BatchSelection> = {},
  now: number = Date.now(),
): Promise<FrozenBatch> {
  const criteria: BatchSelection = { ...DEFAULT_SELECTION, ...selection };

  const conditions = [
    eq(interactionRecords.status, "active"),
    gte(interactionRecords.qualityScore, criteria.minQualityScore),
    inArray(interactionRecords.scope, [...TRAINABLE_SCOPES]),
  ];
  if (criteria.requireDeviceSuccess) {
    conditions.push(eq(interactionRecords.deviceRunSucceeded, true));
  }

  const rows = await db
    .select()
    .from(interactionRecords)
    .where(and(...conditions))
    .orderBy(desc(interactionRecords.qualityScore))
    .limit(criteria.maxRecords);

  const members = rows.map((row) => ({
    recordId: row.id,
    contentHash: contentHashOf(row),
    qualityScore: row.qualityScore,
  }));

  const manifestHash = manifestHashOf(members);
  const frozenAt = new Date(now);

  const [batch] = await db
    .insert(trainingBatches)
    .values({
      label,
      status: "frozen",
      memberCount: members.length,
      manifestHash,
      minQualityScore: criteria.minQualityScore,
      selection: criteria as unknown as Record<string, unknown>,
      evalSetFingerprint: evalSetFingerprint(),
      artifactFingerprint: artifactFingerprint as unknown as Record<string, unknown>,
      frozenAt,
    })
    .returning({ id: trainingBatches.id });

  const batchId = batch!.id;
  if (members.length > 0) {
    await db.insert(trainingBatchMembers).values(
      members.map((m) => ({
        batchId,
        recordId: m.recordId,
        contentHash: m.contentHash,
        qualityScore: m.qualityScore,
      })),
    );
  }

  return {
    id: batchId,
    label,
    memberCount: members.length,
    manifestHash,
    frozenAt: now,
    selection: criteria,
    evalSetFingerprint: evalSetFingerprint(),
    artifactFingerprint,
  };
}

export interface BatchIntegrity {
  batchId: string;
  /** Membership is unchanged since freeze. */
  membershipIntact: boolean;
  /** Members whose content changed after freezing (e.g. late feedback). */
  driftedRecordIds: string[];
  /** Members deleted since freezing (e.g. consent withdrawal). */
  missingRecordIds: string[];
}

/**
 * Distinguishes two different problems.
 *
 * *Membership* changing means the batch record was tampered with — that
 * invalidates it. *Content* drifting is expected and benign: feedback arrives
 * late and rescores an example. Reporting them separately lets a reviewer tell
 * an attack from ordinary lateness, which a single boolean could not.
 */
export async function verifyBatchIntegrity(batchId: string): Promise<BatchIntegrity> {
  const [batch] = await db
    .select()
    .from(trainingBatches)
    .where(eq(trainingBatches.id, batchId))
    .limit(1);

  if (!batch) {
    return { batchId, membershipIntact: false, driftedRecordIds: [], missingRecordIds: [] };
  }

  const members = await db
    .select()
    .from(trainingBatchMembers)
    .where(eq(trainingBatchMembers.batchId, batchId));

  const membershipIntact =
    members.length === batch.memberCount &&
    manifestHashOf(members.map((m) => ({ recordId: m.recordId, contentHash: m.contentHash }))) ===
      batch.manifestHash;

  const current =
    members.length === 0
      ? []
      : await db
          .select()
          .from(interactionRecords)
          .where(
            inArray(
              interactionRecords.id,
              members.map((m) => m.recordId),
            ),
          );

  const currentById = new Map(current.map((r) => [r.id, r]));
  const driftedRecordIds: string[] = [];
  const missingRecordIds: string[] = [];

  for (const member of members) {
    const row = currentById.get(member.recordId);
    if (!row) {
      missingRecordIds.push(member.recordId);
      continue;
    }
    if (contentHashOf(row) !== member.contentHash) driftedRecordIds.push(member.recordId);
  }

  return { batchId, membershipIntact, driftedRecordIds, missingRecordIds };
}

export async function markBatchStatus(
  batchId: string,
  status: "frozen" | "trained" | "discarded",
): Promise<void> {
  await db.update(trainingBatches).set({ status }).where(eq(trainingBatches.id, batchId));
}
