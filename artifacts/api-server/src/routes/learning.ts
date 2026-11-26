/**
 * Consent, feedback, and insight endpoints.
 *
 * These are the routes that make the learning layer reachable by a user. Two
 * things they deliberately do NOT do:
 *
 *  - No endpoint here can start collection for a subject who has not granted
 *    it. `POST /learning/consent` records a grant; nothing else writes.
 *  - No endpoint exposes another subject's data. Feedback is matched on the
 *    caller's own pseudonym, so a guessed run id retrieves nothing.
 */

import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  GetConsentQueryParams,
  SetConsentBody,
  SubmitShortcutFeedbackBody,
  WithdrawConsentBody,
} from "@workspace/api-zod";
import type {
  ConsentState,
  ConsentWithdrawal,
  FeedbackAck,
  LearningInsights,
} from "@workspace/api-zod";

import { assessMaturity } from "../lib/learning/maturity";
import type { ShortcutPlist } from "../lib/shortcuts/catalog";
import {
  hashWorkflowSignature,
  workflowSignatureOf,
  type UserEditEvent,
} from "../lib/learning/records";
import {
  ALL_SCOPES,
  CONSENT_POLICY_VERSION,
  CONSENT_TTL_MS,
  describeScope,
  isCollectionScope,
  mayCollect,
  type ConsentRecord,
} from "../lib/learning/consent";
import {
  attachFeedback,
  countRecords,
  listRecordsForAnalysis,
  loadConsent,
  saveConsent,
  tryAuthorizeCollection,
  withdrawConsentFor,
} from "../lib/learning/collection";
import { subjectPseudonymFrom } from "../lib/learning/collect-run";
import { clusterFailures, type ClusterableRecord } from "../lib/learning/clustering";
import { prioritizeClusters, suggestEvalCases } from "../lib/learning/active-learning";
import type { RetrievedSchemaRef, ValidationEvent } from "../lib/learning/records";

const router: IRouter = Router();

const SCOPE_OPTIONS = ALL_SCOPES.map((scope) => ({
  scope,
  description: describeScope(scope),
}));

function toConsentState(record: ConsentRecord, now: number): ConsentState {
  const active = record.scope !== "none" && mayCollect(record, record.scope, now);
  return {
    scope: record.scope,
    policyVersion: record.policyVersion,
    active,
    options: SCOPE_OPTIONS,
    ...(record.grantedAt
      ? { grantedAt: record.grantedAt, expiresAt: record.grantedAt + CONSENT_TTL_MS }
      : {}),
  };
}

// ── Consent ───────────────────────────────────────────────────────────────────

router.get("/learning/consent", async (req, res): Promise<void> => {
  const parsed = GetConsentQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const subject = subjectPseudonymFrom(parsed.data.subject);
  if (!subject) {
    // An unusable subject id is indistinguishable from no consent, which is
    // the correct default anyway.
    res.json(
      toConsentState(
        {
          scope: "none",
          policyVersion: CONSENT_POLICY_VERSION,
          grantedAt: 0,
          subjectPseudonym: "",
        },
        Date.now(),
      ),
    );
    return;
  }

  try {
    const record = await loadConsent(subject);
    res.json(toConsentState(record, Date.now()));
  } catch (err) {
    req.log.error({ err }, "Failed to read consent");
    res.status(500).json({ error: "Could not read consent." });
  }
});

router.post("/learning/consent", async (req, res): Promise<void> => {
  const parsed = SetConsentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isCollectionScope(parsed.data.scope)) {
    res.status(400).json({ error: `Unrecognised collection scope "${parsed.data.scope}".` });
    return;
  }

  const subject = subjectPseudonymFrom(parsed.data.subject);
  if (!subject) {
    res.status(400).json({ error: "A subject identifier of at least 16 characters is required." });
    return;
  }

  try {
    // Choosing "none" is a withdrawal, not a grant — it must delete what was
    // already collected, or the toggle would be cosmetic.
    if (parsed.data.scope === "none") {
      await withdrawConsentFor(subject);
      res.json(await loadConsent(subject).then((r) => toConsentState(r, Date.now())));
      return;
    }

    const record = await saveConsent(subject, parsed.data.scope);
    res.json(toConsentState(record, Date.now()));
  } catch (err) {
    req.log.error({ err }, "Failed to record consent");
    res.status(500).json({ error: "Could not record consent." });
  }
});

router.post("/learning/consent/withdraw", async (req, res): Promise<void> => {
  const parsed = WithdrawConsentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const subject = subjectPseudonymFrom(parsed.data.subject);
  if (!subject) {
    res.status(400).json({ error: "A subject identifier of at least 16 characters is required." });
    return;
  }

  try {
    const result = await withdrawConsentFor(subject);
    const response: ConsentWithdrawal = {
      scope: "none",
      interactionsPurged: result.interactionsPurged,
      outcomesPurged: result.outcomesPurged,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to withdraw consent");
    res.status(500).json({ error: "Could not withdraw consent." });
  }
});

// ── Feedback ──────────────────────────────────────────────────────────────────

router.post("/learning/feedback", async (req, res): Promise<void> => {
  const parsed = SubmitShortcutFeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const subject = subjectPseudonymFrom(parsed.data.subject);
  if (!subject) {
    const ack: FeedbackAck = { recorded: false, reason: "no-subject" };
    res.json(ack);
    return;
  }

  try {
    // Feedback updates a stored example, so it needs the same scope that
    // allowed the example to be stored. Without consent there is no record to
    // attach to and nothing is created.
    //
    // Edits are corrections, which sit a scope higher. When that scope is
    // missing the submission is not rejected outright — the signals the user
    // *did* consent to are still worth having, so the edits alone are dropped
    // and the caller is told they were.
    const wantsCorrections = (parsed.data.edits?.length ?? 0) > 0;
    const fullPermit = wantsCorrections
      ? await tryAuthorizeCollection(subject, "full-examples")
      : null;
    const permit =
      fullPermit ?? (await tryAuthorizeCollection(subject, "redacted-examples"));
    if (!permit) {
      const ack: FeedbackAck = { recorded: false, reason: "no-consent" };
      res.json(ack);
      return;
    }

    // Derived server-side rather than accepted from the client. The hash is
    // provenance about what the user actually kept, so it is computed here from
    // the plist they sent; only the fingerprint is stored, never the plist.
    const acceptedWorkflowHash = parsed.data.acceptedShortcut
      ? hashWorkflowSignature(
          workflowSignatureOf(parsed.data.acceptedShortcut as ShortcutPlist),
        )
      : undefined;

    const result = await attachFeedback(permit, {
      runId: parsed.data.runId,
      // Everything arriving here is self-reported, whatever the client asserts
      // about it. There is no way to distinguish an observed import from a
      // claimed one over an unauthenticated endpoint, and letting a caller
      // declare the higher-trust "client" source would hand it the higher
      // quality floor — and a route into a training batch — for free.
      source: "user-report",
      ...(parsed.data.importConfirmed !== undefined
        ? { importConfirmed: parsed.data.importConfirmed }
        : {}),
      ...(parsed.data.deviceRunSucceeded !== undefined
        ? { deviceRunSucceeded: parsed.data.deviceRunSucceeded }
        : {}),
      ...(parsed.data.accepted !== undefined ? { accepted: parsed.data.accepted } : {}),
      ...(acceptedWorkflowHash ? { acceptedWorkflowHash } : {}),
      ...(fullPermit && parsed.data.edits?.length
        ? { edits: parsed.data.edits as UserEditEvent[] }
        : {}),
    });

    const ack: FeedbackAck = result.updated
      ? {
          recorded: true,
          ...(wantsCorrections && !fullPermit ? { reason: "edits-not-permitted" } : {}),
        }
      : { recorded: false, reason: "no-matching-run" };
    res.json(ack);
  } catch (err) {
    req.log.error({ err }, "Failed to record feedback");
    res.status(500).json({ error: "Could not record feedback." });
  }
});

// ── Insights ──────────────────────────────────────────────────────────────────

/**
 * Operator-only.
 *
 * The response aggregates other people's contributions, including redacted
 * exemplar text, so it must not be world-readable just because it contains no
 * raw PII. There is no user auth system in this app, so it is gated on an
 * operator token and returns 404 — not 401 — when no token is configured: an
 * unconfigured admin surface should not advertise that it exists.
 */
/**
 * The operator gate, in one place.
 *
 * Extracted rather than copied for the second operator endpoint: a duplicated
 * auth check is one edit away from two different auth checks, and the weaker one
 * would be the one that mattered. Returns true when the caller may proceed and
 * has already been answered otherwise.
 */
function operatorAllowed(req: Parameters<Parameters<IRouter["get"]>[1]>[0], res: Parameters<Parameters<IRouter["get"]>[1]>[1]): boolean {
  const expected = process.env.LEARNING_OPERATOR_TOKEN;
  if (!expected) {
    res.status(404).json({ error: "Not found." });
    return false;
  }
  const supplied = req.get("x-operator-token") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(404).json({ error: "Not found." });
    return false;
  }
  return true;
}

router.get("/learning/insights", async (req, res): Promise<void> => {
  if (!operatorAllowed(req, res)) return;

  try {
    const [totals, rows] = await Promise.all([countRecords(), listRecordsForAnalysis()]);

    const records: ClusterableRecord[] = rows.map((row) => {
      const signature = row.workflowSignature as { actionSequence?: string[] };
      return {
        id: row.id,
        outcome: row.outcome,
        validation: (row.validationHistory ?? []) as ValidationEvent[],
        retrievedSchemas: (row.retrievedSchemas ?? []) as RetrievedSchemaRef[],
        actionSequence: signature?.actionSequence ?? [],
        occurrenceCount: row.occurrenceCount,
        qualityScore: row.qualityScore,
        requestRedacted: row.requestRedacted,
      };
    });

    const clusters = clusterFailures(records);
    const response: LearningInsights = {
      totals,
      clusters: clusters.slice(0, 20),
      priorities: prioritizeClusters(clusters, { limit: 10 }),
      evalCaseSuggestions: suggestEvalCases(clusters, { limit: 5 }),
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to compute learning insights");
    res.status(500).json({ error: "Could not compute insights." });
  }
});

/**
 * What the learning layer has actually demonstrated, derived from live counts.
 *
 * Operator-gated for the same reason as insights, and deliberately outside the
 * generated API contract: it is an internal honesty check, not a product surface,
 * and no client should build UI on it. Every level is computed per request — there
 * is no stored status that could drift away from what the database says.
 */
router.get("/learning/maturity", async (req, res): Promise<void> => {
  if (!operatorAllowed(req, res)) return;

  try {
    res.json(await assessMaturity());
  } catch (err) {
    req.log.error({ err }, "Failed to assess learning maturity");
    res.status(500).json({ error: "Could not assess maturity." });
  }
});

export default router;
