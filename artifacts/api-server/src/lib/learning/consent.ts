/**
 * Explicit-consent boundary for interaction collection.
 *
 * Every path that retains anything derived from a user interaction must pass
 * through `assertCollectionAllowed`. There is no implicit, inherited, or
 * "legitimate interest" route into the corpus.
 *
 * Fails closed in three separate ways:
 *   1. The default record is `scope: "none"` — absence of consent is refusal,
 *      not "not yet asked".
 *   2. Consent is bound to a policy version. Widening what we collect bumps
 *      `CONSENT_POLICY_VERSION`, which invalidates every existing grant and
 *      forces a fresh ask. Old consent cannot silently authorise new uses.
 *   3. Consent expires. A grant older than `CONSENT_TTL_MS` is treated as
 *      withdrawn, so an abandoned session cannot authorise collection forever.
 */

// ── Policy version ────────────────────────────────────────────────────────────

/**
 * Bump on ANY widening of collection: a new field in the record, a new purpose,
 * a new retention period, a new recipient. Narrowing does not require a bump.
 *
 * Format: YYYY-MM-DD.n
 */
export const CONSENT_POLICY_VERSION = "2026-07-29.1";

/** Grants older than this are treated as withdrawn. 180 days. */
export const CONSENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// ── Scopes ────────────────────────────────────────────────────────────────────

/**
 * Ordered from least to most revealing. A grant at one level implies every
 * lower level; it never implies a higher one.
 *
 *  none              Retain nothing. Default.
 *  outcomes-only     Retain derived metrics with no user text at all: which
 *                    gates passed, action counts, token cost, provenance.
 *  redacted-examples Additionally retain the request and generated workflow
 *                    with PII replaced by placeholders.
 *  full-examples     Additionally retain user edits and repair transcripts
 *                    (still redacted — redaction is never optional).
 */
export type CollectionScope =
  | "none"
  | "outcomes-only"
  | "redacted-examples"
  | "full-examples";

const SCOPE_RANK: Record<CollectionScope, number> = {
  none: 0,
  "outcomes-only": 1,
  "redacted-examples": 2,
  "full-examples": 3,
};

/** Runtime guard. The only way a scope earns any authority. */
export function isCollectionScope(value: unknown): value is CollectionScope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCOPE_RANK, value);
}

export const ALL_SCOPES: readonly CollectionScope[] = Object.freeze([
  "none",
  "outcomes-only",
  "redacted-examples",
  "full-examples",
]);

// ── Record ────────────────────────────────────────────────────────────────────

export interface ConsentRecord {
  scope: CollectionScope;
  /** Policy version in force when the grant was made. */
  policyVersion: string;
  /** Unix ms. Null when never granted. */
  grantedAt: number | null;
  /**
   * Pseudonymous subject id (see privacy.pseudonymize). Never a raw user id,
   * email, or device identifier.
   */
  subjectPseudonym: string | null;
}

/** The default for every request that has not explicitly opted in. */
export const NO_CONSENT: Readonly<ConsentRecord> = Object.freeze({
  scope: "none" as CollectionScope,
  policyVersion: CONSENT_POLICY_VERSION,
  grantedAt: null,
  subjectPseudonym: null,
});

export function grantConsent(
  scope: CollectionScope,
  subjectPseudonym: string,
  now: number,
): ConsentRecord {
  return {
    scope,
    policyVersion: CONSENT_POLICY_VERSION,
    grantedAt: scope === "none" ? null : now,
    subjectPseudonym,
  };
}

export function withdrawConsent(existing: ConsentRecord): ConsentRecord {
  return { ...existing, scope: "none", grantedAt: null };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export type ConsentRefusal =
  | "no-grant"
  | "scope-too-narrow"
  | "policy-superseded"
  | "expired"
  /** The record itself is not trustworthy — an unrecognised scope, or a grant
   *  with no subject to attribute or revoke it. */
  | "malformed";

export interface ConsentDecision {
  allowed: boolean;
  refusal?: ConsentRefusal;
  detail: string;
}

/**
 * The single decision function. Returns a reason on refusal so the caller can
 * log *why* nothing was collected without guessing.
 */
export function evaluateConsent(
  consent: ConsentRecord | null | undefined,
  required: CollectionScope,
  now: number,
): ConsentDecision {
  if (required === "none") {
    return { allowed: true, detail: "No consent required to retain nothing." };
  }

  if (!consent || consent.scope === "none" || consent.grantedAt === null) {
    return {
      allowed: false,
      refusal: "no-grant",
      detail: "No consent on record; collection defaults to off.",
    };
  }

  // A consent record is data — it may arrive from a store, an older build, or a
  // request body, and TypeScript guarantees nothing about it at runtime. Both
  // ranks must be validated before they are compared: an unrecognised scope
  // yields `undefined`, and `undefined < n` is false, so an unchecked
  // comparison would ALLOW collection on a corrupt record. Anything we cannot
  // positively recognise is refused.
  if (!isCollectionScope(consent.scope) || !isCollectionScope(required)) {
    return {
      allowed: false,
      refusal: "malformed",
      detail:
        `Unrecognised collection scope (grant "${String(consent.scope)}", ` +
        `required "${String(required)}"); refusing rather than guessing.`,
    };
  }

  // A grant with no subject cannot be attributed or revoked, so it cannot be
  // honoured either.
  if (typeof consent.subjectPseudonym !== "string" || consent.subjectPseudonym.length === 0) {
    return {
      allowed: false,
      refusal: "malformed",
      detail: "Consent record has no subject; it could never be revoked.",
    };
  }

  if (consent.policyVersion !== CONSENT_POLICY_VERSION) {
    return {
      allowed: false,
      refusal: "policy-superseded",
      detail:
        `Consent was given under policy ${consent.policyVersion} but ` +
        `${CONSENT_POLICY_VERSION} is in force; a fresh grant is required.`,
    };
  }

  if (now - consent.grantedAt > CONSENT_TTL_MS) {
    return {
      allowed: false,
      refusal: "expired",
      detail: "Consent has expired and is treated as withdrawn.",
    };
  }

  if (SCOPE_RANK[consent.scope] < SCOPE_RANK[required]) {
    return {
      allowed: false,
      refusal: "scope-too-narrow",
      detail: `Consent covers "${consent.scope}" but "${required}" is required.`,
    };
  }

  return { allowed: true, detail: `Permitted by "${consent.scope}" grant.` };
}

export function mayCollect(
  consent: ConsentRecord | null | undefined,
  required: CollectionScope,
  now: number,
): boolean {
  return evaluateConsent(consent, required, now).allowed;
}

export class ConsentError extends Error {
  readonly refusal: ConsentRefusal;
  constructor(decision: ConsentDecision) {
    super(decision.detail);
    this.name = "ConsentError";
    this.refusal = decision.refusal ?? "no-grant";
  }
}

/**
 * Hard gate. Call before ANY retention. Throws rather than returning false so a
 * forgotten `if` cannot silently become a collection path.
 */
export function assertCollectionAllowed(
  consent: ConsentRecord | null | undefined,
  required: CollectionScope,
  now: number,
): void {
  const decision = evaluateConsent(consent, required, now);
  if (!decision.allowed) throw new ConsentError(decision);
}

/** Human-readable summary for the consent UI and for audit logs. */
export function describeScope(scope: CollectionScope): string {
  switch (scope) {
    case "none":
      return "Nothing is kept. Your requests are used to build your shortcut and then discarded.";
    case "outcomes-only":
      return "Keep anonymous results only — whether generation succeeded, how many actions, and what failed. No text you typed is kept.";
    case "redacted-examples":
      return "Keep your request and the resulting shortcut to improve the generator, with names, addresses, phone numbers, and other personal details replaced by placeholders before storage.";
    case "full-examples":
      return "Also keep the edits and repairs you make, so the generator can learn from corrections. Personal details are still replaced by placeholders.";
  }
}
