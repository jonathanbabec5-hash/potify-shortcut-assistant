/**
 * The collection write path.
 *
 * This is the only module in the codebase permitted to write to the learning
 * tables. Everything else must come through the functions here, and every one
 * of them demands a `CollectionPermit` that can only be obtained by passing a
 * consent check against the database.
 *
 * Why a permit object rather than a `checkConsent()` call at each write site:
 * a check is something you can forget, and forgetting produces a silent,
 * successful, unauthorised write. A required argument is something the compiler
 * will not let you omit. The permit cannot be constructed from outside this
 * module, so there is no way to reach a write function without having gone
 * through `authorizeCollection` first.
 *
 * The permit is re-validated at every write rather than trusted once at mint
 * time. It carries the `ConsentRecord` it was issued against and runs it back
 * through `assertCollectionAllowed`, so an expired policy, a superseded policy
 * version, or a scope too narrow for this particular write all still block —
 * even if they only became true after the permit was issued.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  consentGrants,
  interactionRecords,
  runOutcomes,
  type InteractionRecordRow,
} from "@workspace/db";

import {
  assertCollectionAllowed,
  CONSENT_POLICY_VERSION,
  ConsentError,
  grantConsent,
  isCollectionScope,
  NO_CONSENT,
  type CollectionScope,
  type ConsentRecord,
} from "./consent";
import { assertRedacted, redact, PSEUDONYMS_ARE_DURABLE } from "./privacy";
import type { InteractionDraft } from "./records";
import { sanitizeBuildIdentifier, sanitizeUserEdits } from "./records";
import {
  dedupeKeyFor,
  qualityInputFrom,
  screenRecord,
  scoreQuality,
  type QuarantineReason,
} from "./screening";
import type { RunOutcome } from "./outcomes";

// ── Permit ────────────────────────────────────────────────────────────────────

/** Module-private. Possession of this symbol is what authorises a mint. */
const MINT = Symbol("collection-permit.mint");

/**
 * Permits are short-lived by design. A permit held across a long-running
 * operation must not outlive a withdrawal that happened in the meantime.
 */
export const PERMIT_TTL_MS = 60_000;

export class CollectionPermit {
  readonly consent: Readonly<ConsentRecord>;
  readonly issuedAt: number;

  constructor(key: symbol, consent: Readonly<ConsentRecord>, issuedAt: number) {
    if (key !== MINT) {
      throw new ConsentError({
        allowed: false,
        refusal: "no-grant",
        detail: "CollectionPermit cannot be constructed directly — call authorizeCollection().",
      });
    }
    this.consent = consent;
    this.issuedAt = issuedAt;
  }

  get subjectPseudonym(): string {
    return this.consent.subjectPseudonym ?? "";
  }

  get scope(): CollectionScope {
    return this.consent.scope;
  }
}

/**
 * Re-runs the full consent evaluation for the specific scope this write needs.
 * Throws rather than returning a boolean: a caller that ignores a boolean gets
 * an unauthorised write, a caller that ignores an exception gets nothing.
 */
function assertPermit(
  permit: CollectionPermit,
  required: CollectionScope,
  now: number,
): void {
  if (!(permit instanceof CollectionPermit)) {
    throw new ConsentError({
      allowed: false,
      refusal: "no-grant",
      detail: "A valid CollectionPermit is required to write.",
    });
  }
  if (now - permit.issuedAt > PERMIT_TTL_MS) {
    throw new ConsentError({
      allowed: false,
      refusal: "expired",
      detail: "Collection permit has expired; re-authorise before writing.",
    });
  }
  assertCollectionAllowed(permit.consent, required, now);
}

// ── Consent persistence ───────────────────────────────────────────────────────

/**
 * Reads the stored grant. Anything unrecognised — a missing row, an unknown
 * scope string, a grant with no subject — resolves to NO_CONSENT rather than
 * being repaired or guessed at.
 */
export async function loadConsent(subjectPseudonym: string): Promise<ConsentRecord> {
  if (!subjectPseudonym) return { ...NO_CONSENT };

  const [row] = await db
    .select()
    .from(consentGrants)
    .where(eq(consentGrants.subjectPseudonym, subjectPseudonym))
    .limit(1);

  if (!row || row.withdrawnAt || !row.grantedAt) return { ...NO_CONSENT };
  if (!isCollectionScope(row.scope)) return { ...NO_CONSENT };

  return {
    scope: row.scope,
    policyVersion: row.policyVersion,
    grantedAt: row.grantedAt.getTime(),
    subjectPseudonym: row.subjectPseudonym,
  };
}

export async function saveConsent(
  subjectPseudonym: string,
  scope: CollectionScope,
  now: number = Date.now(),
): Promise<ConsentRecord> {
  if (!isCollectionScope(scope)) {
    throw new ConsentError({
      allowed: false,
      refusal: "malformed",
      detail: `Unrecognised collection scope "${String(scope)}".`,
    });
  }
  if (!subjectPseudonym) {
    throw new ConsentError({
      allowed: false,
      refusal: "malformed",
      detail: "A subject pseudonym is required to record consent.",
    });
  }

  const record = grantConsent(scope, subjectPseudonym, now);
  const grantedAt = new Date(now);

  await db
    .insert(consentGrants)
    .values({
      subjectPseudonym,
      scope,
      policyVersion: CONSENT_POLICY_VERSION,
      grantedAt,
      withdrawnAt: null,
      updatedAt: grantedAt,
    })
    .onConflictDoUpdate({
      target: consentGrants.subjectPseudonym,
      set: {
        scope,
        policyVersion: CONSENT_POLICY_VERSION,
        grantedAt,
        withdrawnAt: null,
        updatedAt: grantedAt,
      },
    });

  return record;
}

export interface WithdrawalResult {
  interactionsPurged: number;
  outcomesPurged: number;
}

/**
 * Withdrawal is not just a flag flip — it deletes what was collected.
 *
 * The row is kept with `withdrawn_at` set so "withdrew" stays distinguishable
 * from "never asked", but every example and measurement attributed to the
 * subject is removed. Anything else would make withdrawal cosmetic.
 */
export async function withdrawConsentFor(
  subjectPseudonym: string,
  now: number = Date.now(),
): Promise<WithdrawalResult> {
  const withdrawnAt = new Date(now);

  await db
    .update(consentGrants)
    .set({ scope: "none", withdrawnAt, updatedAt: withdrawnAt })
    .where(eq(consentGrants.subjectPseudonym, subjectPseudonym));

  return purgeSubject(subjectPseudonym);
}

export async function purgeSubject(subjectPseudonym: string): Promise<WithdrawalResult> {
  const interactions = await db
    .delete(interactionRecords)
    .where(eq(interactionRecords.subjectPseudonym, subjectPseudonym))
    .returning({ id: interactionRecords.id });

  const outcomes = await db
    .delete(runOutcomes)
    .where(eq(runOutcomes.subjectPseudonym, subjectPseudonym))
    .returning({ id: runOutcomes.id });

  return { interactionsPurged: interactions.length, outcomesPurged: outcomes.length };
}

// ── Authorisation ─────────────────────────────────────────────────────────────

export async function authorizeCollection(
  subjectPseudonym: string,
  required: CollectionScope,
  now: number = Date.now(),
): Promise<CollectionPermit> {
  // Data that cannot be found again cannot be deleted on request. If pseudonyms
  // do not survive a restart, a withdrawal would silently orphan rows instead of
  // removing them, so nothing may be collected at all.
  if (!PSEUDONYMS_ARE_DURABLE) {
    throw new ConsentError({
      allowed: false,
      refusal: "malformed",
      detail:
        "Subject pseudonyms are not durable (no LEARNING_SUBJECT_SALT or SESSION_SECRET configured); " +
        "collection is disabled because withdrawal could not reliably delete the data.",
    });
  }

  const consent = await loadConsent(subjectPseudonym);
  assertCollectionAllowed(consent, required, now);
  return new CollectionPermit(MINT, Object.freeze({ ...consent }), now);
}

/**
 * Non-throwing variant for the request path, where "this user has not opted in"
 * is the ordinary case and not an error worth failing a generation over.
 */
export async function tryAuthorizeCollection(
  subjectPseudonym: string,
  required: CollectionScope,
  now: number = Date.now(),
): Promise<CollectionPermit | null> {
  try {
    return await authorizeCollection(subjectPseudonym, required, now);
  } catch (err) {
    if (err instanceof ConsentError) return null;
    throw err;
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

export type CollectionRefusal = "secret-present" | "no-subject";

export interface StoreResult {
  stored: boolean;
  /** Present when stored. */
  id?: string;
  deduplicated?: boolean;
  status?: "active" | "quarantined";
  quarantineReasons?: QuarantineReason[];
  qualityScore?: number;
  refusedBecause?: CollectionRefusal;
}

/**
 * Stores one example.
 *
 * Order matters and is deliberate: redact, then refuse outright on a secret,
 * then prove the text is clean, then screen, then score, then write. A secret
 * short-circuits everything — a credential is not made safe by masking it, and
 * the surrounding text usually reveals what it was for, so the whole record is
 * dropped rather than sanitised.
 */
export async function recordInteraction(
  permit: CollectionPermit,
  draft: InteractionDraft,
  now: number = Date.now(),
): Promise<StoreResult> {
  assertPermit(permit, "redacted-examples", now);
  if (!permit.subjectPseudonym) return { stored: false, refusedBecause: "no-subject" };

  const scan = redact(draft.request);
  if (scan.containsSecret) {
    return { stored: false, refusedBecause: "secret-present" };
  }

  // Defence in depth. If redaction somehow left recognisable PII behind, this
  // throws PiiLeakError and the row is never written.
  assertRedacted(scan.redacted);

  const piiCoverage = scan.findings.reduce((n, f) => n + f.length, 0);
  const screening = screenRecord({
    redactedRequest: scan.redacted,
    requestLength: draft.request.length,
    piiClasses: scan.classes,
    containsSecret: scan.containsSecret,
    piiCoverage,
  });

  // Edits and repairs are a `full-examples` concern. Enforced by dropping the
  // data, not by trusting the caller to have checked the scope.
  const mayKeepCorrections = permit.scope === "full-examples";
  const edits = mayKeepCorrections ? sanitizeUserEdits(draft.edits) : [];
  const repairs = mayKeepCorrections ? draft.repairs : [];

  const qualityScore = scoreQuality({
    ...qualityInputFrom(draft),
    editCount: edits.length,
    repairCount: repairs.length,
  });

  const dedupeKey = dedupeKeyFor(scan.redacted, draft.workflow.actionSequence);
  const consentGrantedAt = new Date(permit.consent.grantedAt ?? now);

  const [row] = await db
    .insert(interactionRecords)
    .values({
      subjectPseudonym: permit.subjectPseudonym,
      scope: permit.scope,
      policyVersion: permit.consent.policyVersion,
      consentGrantedAt,

      runId: draft.runId,
      dedupeKey,
      occurrenceCount: 1,

      requestRedacted: scan.redacted,
      requestLength: draft.request.length,
      piiClasses: scan.classes,

      retrievedSchemas: draft.retrievedSchemas,
      workflowSignature: draft.workflow as unknown as Record<string, unknown>,
      workflowHash: hashOf(draft.workflow.actionSequence),

      validationHistory: draft.validation,
      repairHistory: repairs,
      userEdits: edits,

      accepted: draft.accepted ?? null,
      acceptedWorkflowHash: draft.acceptedWorkflowHash ?? null,

      targetIosVersion: draft.versions.targetIosVersion ?? null,
      minimumIosVersion: draft.versions.minimumIosVersion ?? null,
      appVersion: sanitizeBuildIdentifier(draft.versions.appVersion),
      catalogVersion: draft.provenance.catalogVersion,
      catalogHash: draft.provenance.catalogHash,
      modelId: draft.provenance.modelId,
      systemPromptHash: draft.provenance.systemPromptHash,
      validatorVersion: draft.provenance.validatorVersion,
      pipelineVersion: draft.provenance.pipelineVersion,

      importOffered: draft.signals.importOffered,
      importConfirmed: draft.signals.importConfirmed ?? null,
      deviceRunSucceeded: draft.signals.deviceRunSucceeded ?? null,
      successSignalSource: draft.signals.source ?? null,

      outcome: draft.outcome,
      qualityScore,
      status: screening.status,
      quarantineReasons: screening.reasons,
      updatedAt: new Date(now),
    })
    // A repeat of an example we already have is frequency information, not a
    // second example. Collapsing here keeps the corpus honest — otherwise one
    // popular request would dominate any training batch.
    .onConflictDoUpdate({
      target: interactionRecords.dedupeKey,
      set: {
        occurrenceCount: sql`${interactionRecords.occurrenceCount} + 1`,
        updatedAt: new Date(now),
      },
    })
    .returning({ id: interactionRecords.id, occurrenceCount: interactionRecords.occurrenceCount });

  return {
    stored: true,
    id: row?.id,
    deduplicated: (row?.occurrenceCount ?? 1) > 1,
    status: screening.status,
    quarantineReasons: screening.reasons,
    qualityScore,
  };
}

/** Text-free measurement. Permitted at the lowest non-empty scope. */
export async function recordOutcome(
  permit: CollectionPermit,
  outcome: RunOutcome,
  now: number = Date.now(),
): Promise<{ stored: boolean; id?: string }> {
  assertPermit(permit, "outcomes-only", now);
  if (!permit.subjectPseudonym) return { stored: false };

  const [row] = await db
    .insert(runOutcomes)
    .values({
      subjectPseudonym: permit.subjectPseudonym,
      runId: outcome.runId,
      kind: outcome.kind,
      outcome: outcome.outcome,
      importOffered: outcome.importOffered,
      executableActionCount: outcome.executableActionCount,
      checklistItemCount: outcome.checklistItemCount,
      unsatisfiedItemCount: outcome.unsatisfiedItemCount,
      hardErrorStages: outcome.hardErrorStages,
      advisoryErrorCount: outcome.advisoryErrorCount,
      warningCount: outcome.warningCount,
      uncertaintyCount: outcome.uncertaintyCount,
      descriptionLength: outcome.descriptionLength,
      redactedClasses: outcome.redactedClasses,
      containedSecret: outcome.containedSecret,
      durationMs: outcome.durationMs,
      totalTokens: outcome.cost.totalTokens,
      costByStage: outcome.cost.byStage as unknown[],
      provenance: outcome.provenance as unknown as Record<string, unknown>,
      errorKind: outcome.errorKind ?? null,
      measuredAt: new Date(outcome.measuredAt),
    })
    .returning({ id: runOutcomes.id });

  return { stored: true, id: row?.id };
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export interface FeedbackInput {
  runId: string;
  importConfirmed?: boolean | null;
  deviceRunSucceeded?: boolean | null;
  accepted?: boolean | null;
  acceptedWorkflowHash?: string | null;
  source?: "client" | "user-report";
  edits?: InteractionDraft["edits"];
  repairs?: InteractionDraft["repairs"];
}

/**
 * Attaches the signals that only arrive after the run: whether the import
 * happened, whether it worked on the device, what the user changed.
 *
 * These are the signals that make an example worth training on, and the only
 * ones that can distinguish "the pipeline said it was ready" from "it was".
 * Quality is rescored here because that verdict has now materially changed.
 */
export async function attachFeedback(
  permit: CollectionPermit,
  feedback: FeedbackInput,
  now: number = Date.now(),
): Promise<{ updated: boolean; qualityScore?: number }> {
  const wantsCorrections =
    (feedback.edits?.length ?? 0) > 0 || (feedback.repairs?.length ?? 0) > 0;
  assertPermit(permit, wantsCorrections ? "full-examples" : "redacted-examples", now);

  const [existing] = await db
    .select()
    .from(interactionRecords)
    .where(
      and(
        eq(interactionRecords.runId, feedback.runId),
        eq(interactionRecords.subjectPseudonym, permit.subjectPseudonym),
      ),
    )
    .limit(1);

  if (!existing) return { updated: false };

  // Sanitised here rather than at the route, so the guarantee holds for every
  // caller of the write path and not just the one that happens to be HTTP.
  const edits = wantsCorrections
    ? [...(existing.userEdits as unknown[]), ...sanitizeUserEdits(feedback.edits)]
    : (existing.userEdits as unknown[]);
  const repairs = wantsCorrections
    ? [...(existing.repairHistory as unknown[]), ...(feedback.repairs ?? [])]
    : (existing.repairHistory as unknown[]);

  const accepted = feedback.accepted ?? existing.accepted;
  // Stamped once, on the transition to accepted. Re-confirming later must not
  // move it — this is provenance about when the user settled on a shortcut,
  // not a last-touched column.
  const acceptedAt =
    accepted === true && !existing.acceptedAt ? new Date(now) : existing.acceptedAt;

  const validation = existing.validationHistory as Array<{ advisory?: boolean }>;
  const qualityScore = scoreQuality({
    outcome: existing.outcome,
    importOffered: existing.importOffered,
    importConfirmed: feedback.importConfirmed ?? existing.importConfirmed,
    deviceRunSucceeded: feedback.deviceRunSucceeded ?? existing.deviceRunSucceeded,
    accepted,
    hardErrorCount: validation.filter((v) => v?.advisory === false).length,
    advisoryErrorCount: validation.filter((v) => v?.advisory === true).length,
    uncertaintyCount: 0,
    editCount: edits.length,
    repairCount: repairs.length,
    signalSource:
      feedback.source ??
      (existing.successSignalSource as "client" | "user-report" | null | undefined) ??
      null,
  });

  await db
    .update(interactionRecords)
    .set({
      importConfirmed: feedback.importConfirmed ?? existing.importConfirmed,
      deviceRunSucceeded: feedback.deviceRunSucceeded ?? existing.deviceRunSucceeded,
      accepted,
      acceptedAt,
      acceptedWorkflowHash: feedback.acceptedWorkflowHash ?? existing.acceptedWorkflowHash,
      successSignalSource: feedback.source ?? existing.successSignalSource,
      userEdits: edits,
      repairHistory: repairs,
      qualityScore,
      updatedAt: new Date(now),
    })
    .where(eq(interactionRecords.id, existing.id));

  return { updated: true, qualityScore };
}

// ── Reads (analysis only — no consent needed, the rows are already governed) ──

export async function listRecordsForAnalysis(options: {
  limit?: number;
  includeQuarantined?: boolean;
} = {}): Promise<InteractionRecordRow[]> {
  const statuses = options.includeQuarantined ? ["active", "quarantined"] : ["active"];
  return db
    .select()
    .from(interactionRecords)
    .where(inArray(interactionRecords.status, statuses))
    .limit(options.limit ?? 1_000);
}

export async function countRecords(): Promise<{
  total: number;
  active: number;
  quarantined: number;
}> {
  const rows = await db
    .select({ status: interactionRecords.status, n: sql<number>`count(*)::int` })
    .from(interactionRecords)
    .groupBy(interactionRecords.status);

  let total = 0;
  let active = 0;
  let quarantined = 0;
  for (const row of rows) {
    total += row.n;
    if (row.status === "active") active = row.n;
    if (row.status === "quarantined") quarantined = row.n;
  }
  return { total, active, quarantined };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function hashOf(sequence: readonly string[]): string {
  return createHash("sha256").update(sequence.join(",")).digest("hex");
}
