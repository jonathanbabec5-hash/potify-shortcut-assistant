/**
 * Candidate production.
 *
 * The fail-closed paths are covered here because they are the ones that must
 * hold before any candidate is ever built. Coverage of a *populated* batch is
 * deliberately absent: there are no collected interaction records yet, and a
 * fixture that fabricates them would be testing the fixture rather than the
 * selection logic. Those assertions belong with the first real batch.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CandidateBuildError,
  DEFAULT_MAX_EXEMPLARS,
  DEFAULT_RETRIEVAL,
  buildCandidate,
  renderExemplarBlock,
  type Exemplar,
} from "./candidate";
import { MIN_TRAINABLE_SCOPE, type FrozenBatch } from "./batch";
import {
  CONSENT_POLICY_VERSION,
  CONSENT_TTL_MS,
  evaluateConsent,
  type CollectionScope,
} from "../consent";

/** Fixed so an expiry assertion cannot pass or fail depending on the clock. */
const NOW = Date.UTC(2026, 6, 29);

function exemplar(overrides: Partial<Exemplar> = {}): Exemplar {
  return {
    recordId: "00000000-0000-4000-8000-000000000001",
    requestRedacted: "Turn on the porch light after sunset",
    actionSequence: ["is.workflow.actions.conditional", "is.workflow.actions.notification"],
    controlFlowDepth: 1,
    parameterKeys: ["WFCondition"],
    qualityScore: 0.8,
    occurrenceCount: 2,
    ...overrides,
  };
}

/** Enough of a batch to reach argument validation, which runs before any I/O. */
const STUB_BATCH = {
  id: "00000000-0000-4000-8000-0000000000ff",
  label: "stub",
  selection: { minQualityScore: 0.6, maxRecords: 100, requireDeviceSuccess: false },
} as unknown as FrozenBatch;

// ── Argument validation (fails before touching the database) ─────────────────

test("refuses to build without a parent champion to version against", async () => {
  await assert.rejects(
    () => buildCandidate(STUB_BATCH, { parentChampionId: "   " }),
    CandidateBuildError,
  );
});

test("refuses a non-positive or fractional exemplar cap", async () => {
  for (const maxExemplars of [0, -1, 2.5]) {
    await assert.rejects(
      () => buildCandidate(STUB_BATCH, { parentChampionId: "champion-v1", maxExemplars }),
      CandidateBuildError,
      `maxExemplars=${maxExemplars} should be rejected`,
    );
  }
});

// ── Defaults are bounded ──────────────────────────────────────────────────────

test("exemplars are capped by default so an adapter cannot grow without bound", () => {
  assert.ok(DEFAULT_MAX_EXEMPLARS > 0);
  assert.ok(DEFAULT_MAX_EXEMPLARS <= 64);
  assert.ok(DEFAULT_RETRIEVAL.maxSchemas > 0);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

test("an empty adapter renders to nothing at all", () => {
  assert.equal(renderExemplarBlock([]), "");
});

test("rendering is deterministic and carries only redacted, structural content", () => {
  const one = renderExemplarBlock([exemplar()]);
  const two = renderExemplarBlock([exemplar()]);
  assert.equal(one, two);

  assert.ok(one.includes("Turn on the porch light after sunset"));
  assert.ok(one.includes("is.workflow.actions.conditional > is.workflow.actions.notification"));
  assert.ok(one.includes("depth=1"));
  // Parameter keys are teaching signal; parameter values would be a leak.
  assert.ok(one.includes("params=WFCondition"));
});

test("an exemplar with no parameters omits the params segment", () => {
  const rendered = renderExemplarBlock([exemplar({ parameterKeys: [] })]);
  assert.ok(!rendered.includes("params="));
});

test("ordering is preserved so the rendered block matches the adapter's hash input", () => {
  const a = exemplar({ recordId: "a", requestRedacted: "first request text" });
  const b = exemplar({ recordId: "b", requestRedacted: "second request text" });
  const rendered = renderExemplarBlock([a, b]);
  assert.ok(rendered.indexOf("first request text") < rendered.indexOf("second request text"));
});

// ── Consent re-verification at training time ──────────────────────────────────
//
// A record was written because consent allowed it *then*. Training happens later,
// and "later" is exactly when a grant can have expired or been superseded. These
// cover the resolver the re-verification calls, at the scope it demands — a
// membership test on the scope name would pass all three of these while shipping
// the record into an adapter.

test("consent that has expired since the record was written is refused for training", () => {
  const decision = evaluateConsent(
    {
      subjectPseudonym: "training-subject-pseudonym-0001",
      scope: "full-examples",
      policyVersion: CONSENT_POLICY_VERSION,
      grantedAt: NOW - CONSENT_TTL_MS - 1,
    },
    MIN_TRAINABLE_SCOPE,
    NOW,
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, "expired");
});

test("consent given under a superseded policy is refused for training", () => {
  const decision = evaluateConsent(
    {
      subjectPseudonym: "training-subject-pseudonym-0002",
      scope: "full-examples",
      policyVersion: "1999-01-01.1",
      grantedAt: NOW - 1000,
    },
    MIN_TRAINABLE_SCOPE,
    NOW,
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, "policy-superseded");
});

test("a malformed grant is refused rather than interpreted", () => {
  const decision = evaluateConsent(
    {
      subjectPseudonym: "training-subject-pseudonym-0003",
      // A scope name that is not in the enum. Ranking it would yield undefined,
      // and `undefined < n` is false — an unchecked comparison would ALLOW this.
      scope: "everything" as unknown as CollectionScope,
      policyVersion: CONSENT_POLICY_VERSION,
      grantedAt: NOW - 1000,
    },
    MIN_TRAINABLE_SCOPE,
    NOW,
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, "malformed");
});

test("the trainable scope is a real scope that excludes outcomes-only grants", () => {
  // Outcomes-only consent permits measurement, not retention of examples. If
  // MIN_TRAINABLE_SCOPE ever slipped to "outcomes-only", every such record would
  // become adapter material without anyone agreeing to it.
  const outcomesOnly = evaluateConsent(
    {
      subjectPseudonym: "training-subject-pseudonym-0004",
      scope: "outcomes-only",
      policyVersion: CONSENT_POLICY_VERSION,
      grantedAt: NOW - 1000,
    },
    MIN_TRAINABLE_SCOPE,
    NOW,
  );

  assert.equal(outcomesOnly.allowed, false);
  assert.equal(outcomesOnly.refusal, "scope-too-narrow");
});
