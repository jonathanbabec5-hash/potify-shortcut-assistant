/**
 * Governance boundary between production inference and learning.
 *
 * Two things are enforced here:
 *
 *  A. **Production artifacts are immutable at runtime.** The action catalog,
 *     the system prompt, and the validator version are fingerprinted at boot.
 *     `verifyArtifactIntegrity` recomputes and compares. A live conversation
 *     cannot alter any of them — and if some future code path tries, the
 *     fingerprint check turns a silent drift into a loud failure.
 *
 *  B. **Promotion is a bounded loop with mandatory gates.** `evaluatePromotion`
 *     is fail-closed: every gate in `PROMOTION_GATES` must be present AND
 *     passed. A gate that was never evaluated blocks promotion exactly like a
 *     gate that failed, so forgetting to run one can never read as approval.
 *
 * Nothing in this file trains, mutates, or promotes anything. It defines the
 * boundary that the training subsystem must satisfy before it may exist.
 */

import { createHash } from "node:crypto";

// ── A. Artifact immutability ──────────────────────────────────────────────────

/**
 * Bump when validator behaviour changes in a way that alters pass/fail on the
 * same input. Outcome records carry this so historical measurements are never
 * silently compared across validator semantics.
 */
export const VALIDATOR_VERSION = "1.0.0";

/** Bump when the six-stage pipeline's structure changes. */
export const PIPELINE_VERSION = "6.0.0";

export interface ArtifactFingerprint {
  catalogVersion: string;
  catalogHash: string;
  /**
   * Hash of the **fixed prompt policy** — every instruction the model is held
   * to, with no per-request content in it.
   *
   * Deliberately not a hash of an assembled prompt. Prompts carry only the
   * action schemas retrieved for the request they belong to, so an assembled
   * prompt differs on every call and hashing one would make this field change
   * constantly and mean nothing.
   *
   * Coverage is still complete between the two hashes: the policy hash covers
   * the instructions, `catalogHash` covers the action catalog in full, and
   * schema selection is a pure function of the catalog. There is no way to
   * change what a prompt tells the model without moving one of them.
   */
  systemPromptHash: string;
  validatorVersion: string;
  pipelineVersion: string;
  capturedAt: number;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fingerprintArtifacts(input: {
  catalogVersion: string;
  catalogJson: string;
  /** The fixed policy text only. See `ArtifactFingerprint.systemPromptHash`. */
  promptPolicy: string;
  now: number;
}): ArtifactFingerprint {
  return Object.freeze({
    catalogVersion: input.catalogVersion,
    catalogHash: hashContent(input.catalogJson),
    systemPromptHash: hashContent(input.promptPolicy),
    validatorVersion: VALIDATOR_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    capturedAt: input.now,
  });
}

export class GovernanceViolationError extends Error {
  readonly drifted: string[];
  constructor(drifted: string[]) {
    super(
      `Production artifacts changed at runtime: ${drifted.join(", ")}. ` +
        `Live self-modification of catalogs, prompts, or validators is forbidden.`,
    );
    this.name = "GovernanceViolationError";
    this.drifted = drifted;
  }
}

export interface IntegrityReport {
  ok: boolean;
  drifted: string[];
  baseline: ArtifactFingerprint;
  current: ArtifactFingerprint;
}

export function compareFingerprints(
  baseline: ArtifactFingerprint,
  current: ArtifactFingerprint,
): IntegrityReport {
  const drifted: string[] = [];
  if (baseline.catalogVersion !== current.catalogVersion) drifted.push("catalogVersion");
  if (baseline.catalogHash !== current.catalogHash) drifted.push("catalogHash");
  if (baseline.systemPromptHash !== current.systemPromptHash) drifted.push("systemPromptHash");
  if (baseline.validatorVersion !== current.validatorVersion) drifted.push("validatorVersion");
  if (baseline.pipelineVersion !== current.pipelineVersion) drifted.push("pipelineVersion");
  return { ok: drifted.length === 0, drifted, baseline, current };
}

export function assertArtifactsUnchanged(
  baseline: ArtifactFingerprint,
  current: ArtifactFingerprint,
): void {
  const report = compareFingerprints(baseline, current);
  if (!report.ok) throw new GovernanceViolationError(report.drifted);
}

// ── B. Bounded evaluate → learn → test → promote loop ─────────────────────────

/**
 * The complete set of gates a candidate must clear. Order is the order they
 * should be run in: cheapest and most objective first, human judgement last.
 *
 * Frozen deliberately — a caller must not be able to shorten this list at
 * runtime to make a promotion pass.
 */
export const PROMOTION_GATES = Object.freeze([
  "deterministic-validation",
  "benchmark-improvement",
  "regression",
  "privacy-safety-review",
  "champion-challenger",
  "cost-ceiling",
  "versioning",
  "rollback-plan",
  "human-approval",
] as const);

export type PromotionGateId = (typeof PROMOTION_GATES)[number];

export interface GateResult {
  gate: PromotionGateId;
  passed: boolean;
  /** Evidence: metric deltas, reviewer, run id. Shown in the promotion record. */
  detail: string;
  evaluatedAt: number;
}

export interface PromotionRequest {
  candidateId: string;
  championId: string;
  results: readonly GateResult[];
}

export interface PromotionDecision {
  approved: boolean;
  candidateId: string;
  championId: string;
  /** Gates that failed. */
  failed: PromotionGateId[];
  /** Gates with no result at all — treated exactly like a failure. */
  missing: PromotionGateId[];
  /** Gates evaluated more than once with conflicting verdicts. */
  conflicted: PromotionGateId[];
  decidedAt: number;
  summary: string;
}

/**
 * Fail-closed promotion decision.
 *
 * A candidate is approved only when every gate in PROMOTION_GATES has exactly
 * one result and that result passed. Missing, failed, and self-contradictory
 * gates all block. There is no override parameter — bypassing a gate requires
 * changing this function in a reviewed commit, which is the point.
 */
export function evaluatePromotion(
  request: PromotionRequest,
  now: number,
): PromotionDecision {
  const byGate = new Map<PromotionGateId, GateResult[]>();
  for (const r of request.results) {
    if (!PROMOTION_GATES.includes(r.gate)) continue; // unknown gates carry no authority
    const list = byGate.get(r.gate) ?? [];
    list.push(r);
    byGate.set(r.gate, list);
  }

  const failed: PromotionGateId[] = [];
  const missing: PromotionGateId[] = [];
  const conflicted: PromotionGateId[] = [];

  for (const gate of PROMOTION_GATES) {
    const results = byGate.get(gate);
    if (!results || results.length === 0) {
      missing.push(gate);
      continue;
    }
    const verdicts = new Set(results.map((r) => r.passed));
    if (verdicts.size > 1) {
      conflicted.push(gate);
      continue;
    }
    if (!results[0]!.passed) failed.push(gate);
  }

  const blocked = failed.length + missing.length + conflicted.length;
  const approved = blocked === 0;

  const summary = approved
    ? `All ${PROMOTION_GATES.length} gates passed; ${request.candidateId} may replace ${request.championId}.`
    : `Blocked: ${failed.length} failed, ${missing.length} not evaluated, ${conflicted.length} conflicting.`;

  return {
    approved,
    candidateId: request.candidateId,
    championId: request.championId,
    failed,
    missing,
    conflicted,
    decidedAt: now,
    summary,
  };
}

/**
 * Rollback target for a promoted candidate. Recorded at promotion time so a
 * revert never depends on reconstructing what the previous state was.
 */
export interface RollbackPlan {
  /** Version to restore. */
  revertTo: string;
  /** How the revert is performed. */
  method: "config-flag" | "redeploy" | "weight-swap";
  /** Outcome metric that, if breached in production, triggers the revert. */
  triggerMetric: string;
  triggerThreshold: number;
  recordedAt: number;
}

export function isRollbackPlanUsable(plan: RollbackPlan | null | undefined): boolean {
  return Boolean(
    plan &&
      plan.revertTo.trim().length > 0 &&
      plan.triggerMetric.trim().length > 0 &&
      Number.isFinite(plan.triggerThreshold),
  );
}
