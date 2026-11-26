/**
 * Deduplication, quality scoring, and quarantine.
 *
 * Everything here is deterministic and pure. A record's fate must not depend on
 * when it was screened or what else was in the batch, or two runs over the same
 * corpus would produce different training sets.
 *
 * The three functions answer three different questions:
 *
 *   dedupeKeyFor   — "have we already got this example?"
 *   screenRecord   — "is this example safe to keep at all?"
 *   scoreQuality   — "how much should we trust it as a training target?"
 *
 * Quarantine and quality are deliberately separate. A low-quality example is
 * still evidence about where the pipeline fails and belongs in failure
 * clustering; a quarantined one is untrusted input and must not influence
 * anything. Collapsing them into one number would lose that distinction.
 */

import { createHash } from "node:crypto";
import type { InteractionDraft } from "./records";
import type { PiiClass } from "./privacy";

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Normalises to the form where two requests that differ only in phrasing noise
 * collapse together: case, whitespace, and trailing punctuation. Redaction
 * placeholders are left intact, so "text [[PERSON_NAME_1]]" from two different
 * users is correctly one example rather than two.
 */
export function normalizeRequest(redactedRequest: string): string {
  return redactedRequest
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+(?=\s|$)/g, "")
    .trim();
}

/**
 * The identity of an example: what was asked plus what was produced.
 *
 * Both halves matter. The same request that produces two different workflows is
 * two examples — that divergence is the signal. The same workflow from two
 * different requests is also two examples.
 */
export function dedupeKeyFor(redactedRequest: string, actionSequence: readonly string[]): string {
  return createHash("sha256")
    .update(normalizeRequest(redactedRequest))
    .update("\u0000")
    .update(actionSequence.join(","))
    .digest("hex");
}

// ── Quarantine ────────────────────────────────────────────────────────────────

export type QuarantineReason =
  | "secret-present"
  | "prompt-injection"
  | "action-identifier-injection"
  | "exfiltration-request"
  | "control-characters"
  | "excessive-length"
  | "high-pii-density"
  | "trivial-content";

export interface ScreeningResult {
  status: "active" | "quarantined";
  reasons: QuarantineReason[];
}

/** Roughly two paragraphs. Beyond this a "description" is something else. */
const MAX_REQUEST_LENGTH = 4_000;

/**
 * Attempts to talk to the model rather than describe a shortcut.
 *
 * These are matched against the REDACTED text, which is fine — redaction
 * replaces personal data, not instruction phrasing.
 */
const INJECTION_PATTERNS: ReadonlyArray<readonly [QuarantineReason, RegExp]> = Object.freeze([
  ["prompt-injection", /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\b/i],
  ["prompt-injection", /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|your)\b/i],
  ["prompt-injection", /\b(?:system|developer)\s+prompt\b/i],
  ["prompt-injection", /\byou\s+are\s+now\b/i],
  ["prompt-injection", /\b(?:reveal|print|repeat|output)\s+(?:your|the)\s+(?:instructions|prompt|rules|system)\b/i],
  ["prompt-injection", /<\/?\s*(?:system|assistant|user)\s*>/i],
  ["prompt-injection", /^\s*(?:system|assistant)\s*:/im],
  ["prompt-injection", /\bjailbreak\b/i],
  // Users describe outcomes ("text my wife"), not identifiers. Raw identifiers
  // in a description are an attempt to steer grounding directly.
  ["action-identifier-injection", /\bis\.workflow\.actions\./i],
  // Bulk personal data plus an outbound destination.
  // The quantifier and the noun are separated by a lazy gap rather than an
  // optional "my", because the natural adversarial phrasings put words between
  // them — "every one of my photos", "all of my contacts", "every single note".
  // Requiring them to be adjacent let those straight through.
  [
    "exfiltration-request",
    /\b(?:all|every|each)\b[\s\S]{0,20}?\b(?:contacts?|photos?|messages?|passwords?|notes?|emails?)\b[\s\S]{0,80}\b(?:upload|send|post|export|sync)\b/i,
  ],
  [
    "exfiltration-request",
    /\b(?:upload|send|post|export)\b[\s\S]{0,60}\b(?:all|every|each)\b[\s\S]{0,20}?\b(?:contacts?|photos?|messages?|passwords?|notes?|emails?)\b/i,
  ],
]);

/**
 * C0 controls (except tab/newline/carriage return), bidi overrides, and
 * zero-width characters. All three are used to make text render differently
 * from how it parses.
 */
const OBFUSCATION_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;

export interface ScreenInput {
  redactedRequest: string;
  /** Raw length, before redaction. */
  requestLength: number;
  piiClasses: readonly PiiClass[];
  containsSecret: boolean;
  /** Total characters covered by PII findings, for density. */
  piiCoverage: number;
}

export function screenRecord(input: ScreenInput): ScreeningResult {
  const reasons: QuarantineReason[] = [];

  // A secret should have caused the record to be dropped before it got here.
  // Screening for it again means a bypass shows up as a quarantined row rather
  // than a stored credential.
  if (input.containsSecret) reasons.push("secret-present");

  if (input.requestLength > MAX_REQUEST_LENGTH) reasons.push("excessive-length");
  if (OBFUSCATION_PATTERN.test(input.redactedRequest)) reasons.push("control-characters");

  for (const [reason, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(input.redactedRequest) && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }

  // Mostly-redacted text carries little learnable structure and a lot of risk.
  if (input.requestLength > 0 && input.piiCoverage / input.requestLength > 0.4) {
    reasons.push("high-pii-density");
  }

  // Strip placeholders before measuring substance, so "[[EMAIL_1]]" alone
  // doesn't read as a real description.
  const substantive = input.redactedRequest.replace(/\[\[[A-Z_]+_\d+\]\]/g, "").trim();
  if (substantive.length < 8) reasons.push("trivial-content");

  return {
    status: reasons.length > 0 ? "quarantined" : "active",
    reasons,
  };
}

// ── Quality scoring ───────────────────────────────────────────────────────────

/** Base credibility by terminal state, before evidence adjusts it. */
const OUTCOME_BASE: Record<string, number> = Object.freeze({
  ready: 0.6,
  incomplete: 0.15,
  unsupported: 0.15,
  "validation-failed": 0.1,
  unverified: 0.0,
  "cost-exceeded": 0.0,
  error: 0.0,
});

/**
 * A floor for examples a human actually put on their device and confirmed
 * worked. Whatever the pipeline's own verdict was, that artifact is a valid
 * training target — arguably a better one than a clean first attempt, because
 * it survived contact with a real device.
 */
/**
 * Floor for an example a human confirmed actually ran, where the confirmation
 * came from something other than the subject's own unverified say-so.
 */
const HUMAN_VALIDATED_FLOOR = 0.7;

/**
 * Floor when the only evidence is the subject reporting their own success.
 *
 * Deliberately below the default training threshold (0.6). A self-report is a
 * useful signal but an unauthenticated one: anyone can POST "this worked" about
 * their own record, and if that alone cleared the training bar it would be a
 * direct route for pushing a low-quality example into a batch. So a self-report
 * can raise a mediocre score, but it cannot by itself rescue a bad example into
 * training — a genuinely good run clears 0.6 on its own merits anyway.
 */
const SELF_REPORTED_FLOOR = 0.5;

export interface QualityInput {
  outcome: string;
  importOffered: boolean;
  importConfirmed?: boolean | null;
  deviceRunSucceeded?: boolean | null;
  accepted?: boolean | null;
  hardErrorCount: number;
  advisoryErrorCount: number;
  uncertaintyCount: number;
  editCount: number;
  repairCount: number;
  /** Where the success signal came from. Unverified self-reports earn less. */
  signalSource?: "client" | "user-report" | null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Deterministic 0..1 trustworthiness of this example as a training target.
 *
 * Note what this is NOT: a measure of how interesting the example is. A score
 * of 0.05 on a frequently-recurring failure is exactly what active learning
 * looks for. Quality gates training; frequency drives prioritisation.
 */
export function scoreQuality(input: QualityInput): number {
  let score = OUTCOME_BASE[input.outcome] ?? 0;

  if (input.importOffered) score += 0.15;
  if (input.importConfirmed === true) score += 0.05;
  if (input.accepted === true) score += 0.1;
  if (input.accepted === false) score -= 0.1;

  if (input.deviceRunSucceeded === true) score += 0.15;
  // The strongest negative available: it looked right and was not.
  if (input.deviceRunSucceeded === false) score -= 0.3;

  score -= Math.min(0.2, input.hardErrorCount * 0.05);
  score -= Math.min(0.1, input.advisoryErrorCount * 0.02);
  score -= Math.min(0.1, input.uncertaintyCount * 0.02);
  // Edits and repairs both mean the first attempt was wrong.
  score -= Math.min(0.15, input.editCount * 0.03);
  score -= Math.min(0.1, input.repairCount * 0.05);

  const humanValidated = input.accepted === true && input.deviceRunSucceeded === true;
  if (humanValidated) {
    const selfReported = input.signalSource === "user-report";
    score = Math.max(score, selfReported ? SELF_REPORTED_FLOOR : HUMAN_VALIDATED_FLOOR);
  }

  return Number(clamp01(score).toFixed(4));
}

export function qualityInputFrom(draft: InteractionDraft): QualityInput {
  return {
    outcome: draft.outcome,
    importOffered: draft.signals.importOffered,
    importConfirmed: draft.signals.importConfirmed ?? null,
    deviceRunSucceeded: draft.signals.deviceRunSucceeded ?? null,
    accepted: draft.accepted ?? null,
    hardErrorCount: draft.validation.filter((v) => !v.advisory).length,
    advisoryErrorCount: draft.validation.filter((v) => v.advisory).length,
    uncertaintyCount: draft.uncertaintyCount,
    editCount: draft.edits.length,
    repairCount: draft.repairs.length,
    signalSource: draft.signals.source ?? null,
  };
}
