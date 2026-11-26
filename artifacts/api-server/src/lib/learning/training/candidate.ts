/**
 * Candidate production.
 *
 * ⚠️  Offline only. Nothing in the request path may import this module — see
 *     `training-isolation.test.ts`, which fails the build if anything does.
 *
 * This is the step that was missing: `runCycle` consumes a challenger, and
 * until now nothing produced one, so the entire promotion apparatus was
 * unreachable. This module turns a frozen batch into a *candidate adapter*.
 *
 * ## Why an adapter and not fine-tuned weights
 *
 * Neither configured provider exposes a fine-tuning API, so "candidate model"
 * cannot mean new weights here. It means a versioned, content-addressed bundle
 * of things that demonstrably change generation behaviour:
 *
 *   - curated exemplars drawn from the frozen batch, and
 *   - retrieval parameters used when assembling context.
 *
 * That is a genuine improvement over opaque weights for this system's stated
 * goal. An adapter is inspectable, diffable, and revertible: a reviewer can
 * read exactly what a candidate learned before approving it, and rollback is a
 * pointer change rather than a redeploy. "Bounded evaluate-learn-test-promote,
 * not unrestricted self-modification" is much easier to actually honour when
 * the artifact under review is legible.
 *
 * ## What this module refuses to do
 *
 * Building a candidate re-verifies every guarantee the batch is supposed to
 * carry rather than trusting the freeze. Freezing happened at some point in the
 * past; consent can be withdrawn, a record can be quarantined, and feedback can
 * rescore an example in the meantime. Trusting a stale snapshot is exactly how
 * a withdrawn example ends up in a shipped model, so every record is re-read
 * and re-checked at build time, and anything that no longer qualifies is
 * dropped and counted.
 */

import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  interactionRecords,
  trainingBatchMembers,
  trainingCandidates,
  type InteractionRecordRow,
} from "@workspace/db";

import { evaluateConsent, type CollectionScope, type ConsentRecord } from "../consent";
import { detectPii } from "../privacy";
import { MIN_TRAINABLE_SCOPE, verifyBatchIntegrity, type FrozenBatch } from "./batch";

// ── Shapes ────────────────────────────────────────────────────────────────────

/**
 * One teaching example.
 *
 * Every field is either already-redacted text or a structural signature. There
 * is deliberately no path here to a raw request, a plist, or a parameter
 * *value* — only parameter keys. An exemplar that cannot carry a value cannot
 * leak one.
 */
export interface Exemplar {
  recordId: string;
  requestRedacted: string;
  actionSequence: string[];
  controlFlowDepth: number;
  parameterKeys: string[];
  qualityScore: number;
  /** How often this example recurred — a weak signal of how typical it is. */
  occurrenceCount: number;
}

/** Why records in the batch did not become exemplars. Recorded, not silent. */
export interface ExclusionTally {
  drifted: number;
  missing: number;
  inactive: number;
  scopeNotTrainable: number;
  /**
   * Consent aged past `CONSENT_TTL_MS`.
   *
   * Previously invisible. Withdrawal deletes a subject's records outright, so
   * the re-verification pass caught it — but a grant that simply *expired* left
   * the record `active` with a trainable scope forever, and it would have been
   * trained on indefinitely. Consent that can no longer authorise collection
   * cannot authorise training either.
   */
  consentExpired: number;
  /** Consent given under a policy version no longer in force. */
  consentPolicySuperseded: number;
  /** Consent record not trustworthy — unrecognised scope, or no subject. */
  consentMalformed: number;
  belowQuality: number;
  malformedSignature: number;
  piiSuspected: number;
  overCap: number;
}

export interface RetrievalParams {
  /** Upper bound on action schemas assembled into context. */
  maxSchemas: number;
  /** Minimum relevance score for a schema to be included. */
  minScore: number;
}

export interface CandidateProvenance {
  batchId: string;
  batchLabel: string;
  batchManifestHash: string;
  batchMemberCount: number;
  evalSetFingerprint: string;
  artifactFingerprint: FrozenBatch["artifactFingerprint"];
  builtAt: number;
}

export interface CandidateAdapter {
  /** Content-addressed, so the same inputs always name the same candidate. */
  id: string;
  /** Time-ordered and content-suffixed: monotonic, and unique per content. */
  version: string;
  parentChampionId: string;
  strategy: "exemplar-prompt-adapter";
  exemplars: readonly Exemplar[];
  retrieval: RetrievalParams;
  provenance: CandidateProvenance;
  exclusions: ExclusionTally;
  /** Rough prompt cost of carrying this adapter, for the cost-ceiling gate. */
  estimatedPromptTokens: number;
  contentHash: string;
}

export class CandidateBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateBuildError";
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/**
 * Exemplars are capped because an adapter that grows without bound silently
 * turns into the very "full catalog in every prompt" problem this system is
 * trying to get away from.
 */
export const DEFAULT_MAX_EXEMPLARS = 32;

export const DEFAULT_RETRIEVAL: Readonly<RetrievalParams> = Object.freeze({
  maxSchemas: 24,
  minScore: 0.3,
});

export interface CandidateOptions {
  parentChampionId: string;
  maxExemplars?: number;
  retrieval?: RetrievalParams;
}

// ── Narrowing ─────────────────────────────────────────────────────────────────

/**
 * Extracts the safe fields, or returns null.
 *
 * Returning null rather than coercing is deliberate: a record whose signature
 * is not the shape we expect is a record we do not understand, and guessing at
 * its meaning is how malformed data becomes training signal.
 */
function exemplarFrom(row: InteractionRecordRow): Exemplar | null {
  const signature = row.workflowSignature as Record<string, unknown> | null;
  if (!signature || typeof signature !== "object") return null;

  const rawSequence = signature.actionSequence;
  if (!Array.isArray(rawSequence)) return null;
  if (rawSequence.some((a) => typeof a !== "string")) return null;
  const actionSequence = rawSequence as string[];
  if (actionSequence.length === 0) return null;

  const depth = signature.controlFlowDepth;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) return null;

  const rawKeys = signature.parameterKeys;
  const parameterKeys = Array.isArray(rawKeys)
    ? rawKeys.filter((k): k is string => typeof k === "string")
    : [];

  const request = row.requestRedacted;
  if (typeof request !== "string" || request.trim().length === 0) return null;

  return {
    recordId: row.id,
    requestRedacted: request,
    actionSequence,
    controlFlowDepth: depth,
    parameterKeys,
    qualityScore: row.qualityScore,
    occurrenceCount: row.occurrenceCount,
  };
}

/**
 * Reconstructs the consent record a stored interaction was collected under.
 *
 * The row carries the scope, policy version, grant time, and subject that were
 * in force at collection. Rebuilding them into a `ConsentRecord` lets the one
 * canonical `evaluateConsent` judge training eligibility, instead of this module
 * re-implementing a partial version of the same rules.
 */
function consentOf(row: InteractionRecordRow): ConsentRecord {
  return {
    scope: row.scope as CollectionScope,
    policyVersion: row.policyVersion,
    grantedAt: row.consentGrantedAt ? row.consentGrantedAt.getTime() : null,
    subjectPseudonym: row.subjectPseudonym,
  };
}

/** ~4 characters per token is close enough to gate on, and errs high. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The compact block an adapter contributes to a prompt.
 *
 * Exported because a candidate that cannot be read is a candidate that cannot
 * be reviewed, and human approval is one of the nine gates.
 */
export function renderExemplarBlock(exemplars: readonly Exemplar[]): string {
  if (exemplars.length === 0) return "";
  const lines = exemplars.map((e) => {
    const keys = e.parameterKeys.length > 0 ? ` params=${e.parameterKeys.join(",")}` : "";
    return `- "${e.requestRedacted}" -> [${e.actionSequence.join(" > ")}] depth=${e.controlFlowDepth}${keys}`;
  });
  return `VERIFIED EXAMPLES (request -> action sequence):\n${lines.join("\n")}`;
}

function contentHashOfAdapter(input: {
  parentChampionId: string;
  strategy: string;
  exemplars: readonly Exemplar[];
  retrieval: RetrievalParams;
  batchManifestHash: string;
}): string {
  const canonical = JSON.stringify({
    p: input.parentChampionId,
    s: input.strategy,
    r: input.retrieval,
    b: input.batchManifestHash,
    e: input.exemplars.map((x) => ({
      i: x.recordId,
      q: x.requestRedacted,
      a: x.actionSequence,
      d: x.controlFlowDepth,
      k: x.parameterKeys,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Turns a frozen batch into a candidate adapter.
 *
 * Throws if the batch was tampered with. Every other disqualification drops the
 * individual record and is counted in `exclusions`, because one withdrawn
 * example should not destroy a batch — but it must never be silent either.
 */
export async function buildCandidate(
  batch: FrozenBatch,
  options: CandidateOptions,
  now: number = Date.now(),
): Promise<CandidateAdapter> {
  const maxExemplars = options.maxExemplars ?? DEFAULT_MAX_EXEMPLARS;
  if (!Number.isInteger(maxExemplars) || maxExemplars < 1) {
    throw new CandidateBuildError(`maxExemplars must be a positive integer, got ${maxExemplars}.`);
  }
  if (options.parentChampionId.trim().length === 0) {
    throw new CandidateBuildError("A parent champion id is required to version a candidate.");
  }

  const retrieval = options.retrieval ?? DEFAULT_RETRIEVAL;

  // A batch whose membership no longer matches its manifest is not a batch, it
  // is an unknown set of records. Refuse rather than train on it.
  const integrity = await verifyBatchIntegrity(batch.id);
  if (!integrity.membershipIntact) {
    throw new CandidateBuildError(
      `Batch ${batch.id} membership does not match its frozen manifest; refusing to build a candidate.`,
    );
  }

  const exclusions: ExclusionTally = {
    drifted: integrity.driftedRecordIds.length,
    missing: integrity.missingRecordIds.length,
    inactive: 0,
    scopeNotTrainable: 0,
    consentExpired: 0,
    consentPolicySuperseded: 0,
    consentMalformed: 0,
    belowQuality: 0,
    malformedSignature: 0,
    piiSuspected: 0,
    overCap: 0,
  };

  const members = await db
    .select()
    .from(trainingBatchMembers)
    .where(inArray(trainingBatchMembers.batchId, [batch.id]));

  // Drifted records are excluded rather than used. Their content changed after
  // the batch was justified, so they are no longer the examples that were
  // reviewed — benign in origin, but not what this batch means.
  const excluded = new Set([...integrity.driftedRecordIds, ...integrity.missingRecordIds]);
  const eligibleIds = members.map((m) => m.recordId).filter((id) => !excluded.has(id));

  if (eligibleIds.length === 0) {
    throw new CandidateBuildError(
      `Batch ${batch.id} has no eligible members after integrity filtering; nothing to learn from.`,
    );
  }

  const rows = await db
    .select()
    .from(interactionRecords)
    .where(inArray(interactionRecords.id, eligibleIds));

  const exemplars: Exemplar[] = [];

  for (const row of rows) {
    // Re-checked here, not inherited from the freeze. Quarantine and withdrawal
    // can both happen after a batch is frozen.
    if (row.status !== "active") {
      exclusions.inactive += 1;
      continue;
    }

    // Consent is re-evaluated with the *same* resolver collection uses, not with
    // a scope-name membership test. A membership test only asks "is this scope
    // trainable"; it cannot see that the grant expired or was given under a
    // superseded policy, and both of those were previously invisible here. A
    // record whose consent could no longer authorise collecting it must not
    // authorise training on it either.
    const decision = evaluateConsent(consentOf(row), MIN_TRAINABLE_SCOPE, now);
    if (!decision.allowed) {
      switch (decision.refusal) {
        case "expired":
          exclusions.consentExpired += 1;
          break;
        case "policy-superseded":
          exclusions.consentPolicySuperseded += 1;
          break;
        case "malformed":
          exclusions.consentMalformed += 1;
          break;
        default:
          // no-grant and scope-too-narrow both mean the scope on the record does
          // not reach the training threshold.
          exclusions.scopeNotTrainable += 1;
      }
      continue;
    }

    if (row.qualityScore < batch.selection.minQualityScore) {
      exclusions.belowQuality += 1;
      continue;
    }

    const exemplar = exemplarFrom(row);
    if (!exemplar) {
      exclusions.malformedSignature += 1;
      continue;
    }

    // Defence in depth. `requestRedacted` is redacted at the write boundary, so
    // a finding here means something upstream failed. Dropping the record is
    // the safe direction; a candidate is not worth a leak.
    if (detectPii(exemplar.requestRedacted).length > 0) {
      exclusions.piiSuspected += 1;
      continue;
    }

    exemplars.push(exemplar);
  }

  if (exemplars.length === 0) {
    throw new CandidateBuildError(
      `Batch ${batch.id} yielded no usable exemplars (${JSON.stringify(exclusions)}).`,
    );
  }

  // Deterministic ordering: quality first, then record id to break ties. Two
  // builds from the same batch must produce byte-identical candidates, or the
  // content hash means nothing.
  exemplars.sort(
    (a, b) => b.qualityScore - a.qualityScore || a.recordId.localeCompare(b.recordId),
  );

  if (exemplars.length > maxExemplars) {
    exclusions.overCap = exemplars.length - maxExemplars;
    exemplars.length = maxExemplars;
  }

  const contentHash = contentHashOfAdapter({
    parentChampionId: options.parentChampionId,
    strategy: "exemplar-prompt-adapter",
    exemplars,
    retrieval,
    batchManifestHash: batch.manifestHash,
  });

  const adapter: CandidateAdapter = {
    id: `cand-${contentHash.slice(0, 16)}`,
    version: `${new Date(now).toISOString()}+${contentHash.slice(0, 8)}`,
    parentChampionId: options.parentChampionId,
    strategy: "exemplar-prompt-adapter",
    exemplars,
    retrieval,
    provenance: {
      batchId: batch.id,
      batchLabel: batch.label,
      batchManifestHash: batch.manifestHash,
      batchMemberCount: batch.memberCount,
      evalSetFingerprint: batch.evalSetFingerprint,
      artifactFingerprint: batch.artifactFingerprint,
      builtAt: now,
    },
    exclusions,
    estimatedPromptTokens: estimateTokens(renderExemplarBlock(exemplars)),
    contentHash,
  };

  return adapter;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Records the candidate so versioning and rollback refer to something real.
 *
 * Stored as `candidate`. Nothing here marks a champion — that transition
 * belongs to a human acting on an approved promotion decision, and putting it
 * in this module would hand the training job the authority it must not have.
 */
export async function persistCandidate(adapter: CandidateAdapter): Promise<void> {
  await db
    .insert(trainingCandidates)
    .values({
      candidateId: adapter.id,
      version: adapter.version,
      parentChampionId: adapter.parentChampionId,
      batchId: adapter.provenance.batchId,
      strategy: adapter.strategy,
      contentHash: adapter.contentHash,
      exemplarCount: adapter.exemplars.length,
      estimatedPromptTokens: adapter.estimatedPromptTokens,
      adapter: adapter as unknown as Record<string, unknown>,
      provenance: adapter.provenance as unknown as Record<string, unknown>,
      exclusions: adapter.exclusions as unknown as Record<string, unknown>,
      status: "candidate",
    })
    // Rebuilding the same batch is idempotent rather than an error — the
    // content hash already says it is the same candidate.
    .onConflictDoNothing({ target: trainingCandidates.candidateId });
}

/**
 * Whether a stored candidate exists under this id.
 *
 * Used by the rollback gate. A rollback plan naming a version that was never
 * stored is a sentence, not a mechanism, and the gate should not accept one.
 */
export async function candidateExists(candidateId: string): Promise<boolean> {
  const rows = await db
    .select({ candidateId: trainingCandidates.candidateId })
    .from(trainingCandidates)
    .where(eq(trainingCandidates.candidateId, candidateId))
    .limit(1);
  return rows.length > 0;
}
