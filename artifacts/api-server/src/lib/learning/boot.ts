/**
 * Boot-time artifact fingerprint.
 *
 * The governing rule for this system is that nothing learns in production. The
 * catalog, the system prompt, the validator, and the pipeline are fixed for the
 * lifetime of a process, and a candidate only reaches users through an offline
 * promotion decision.
 *
 * This module captures those artifacts once at startup so any later drift is
 * detectable rather than theoretical. It is checked from the integrity route,
 * not from the request path — a per-request hash of the whole catalog would be
 * a pointless cost, and the failure mode it guards against (something mutating
 * the catalog or the prompt at runtime) is process-scoped, not request-scoped.
 */
import { catalog } from "../shortcuts/catalog";
import { buildPromptPolicy } from "../shortcuts/llm";
import { MODEL_CONFIG } from "../shortcuts/model-config";
import {
  compareFingerprints,
  fingerprintArtifacts,
  type ArtifactFingerprint,
  type IntegrityReport,
} from "./governance";
import { verifyEvalSetIntegrity, type EvalSetIntegrityReport } from "./eval-set";
import { provenanceFrom, type RunProvenance } from "./outcomes";

/**
 * Fingerprints the *fixed prompt policy*, not an assembled prompt.
 *
 * Prompts are now scoped per request: each one carries only the action schemas
 * retrieved for it. Hashing an assembled prompt would therefore produce a
 * different value on every request and the integrity check would fail
 * constantly — which in practice means it would be deleted, and the guarantee
 * would be gone.
 *
 * Splitting it loses nothing. The policy hash covers every instruction the model
 * is held to, `catalogHash` covers the action catalog in full, and schema
 * selection is a pure function of that catalog. Anything that could change what
 * a prompt says still moves one of these two hashes.
 */
function snapshot(now: number): ArtifactFingerprint {
  return fingerprintArtifacts({
    catalogVersion: catalog.version,
    catalogJson: JSON.stringify(catalog),
    promptPolicy: buildPromptPolicy(),
    now,
  });
}

/** Captured once, at module load. The baseline every later check compares to. */
export const BOOT_FINGERPRINT: ArtifactFingerprint = snapshot(Date.now());

/**
 * Stamped onto every measured run so outcomes from different catalog or prompt
 * versions are never silently pooled into one benchmark.
 */
export const RUN_PROVENANCE: RunProvenance = provenanceFrom({
  catalogVersion: BOOT_FINGERPRINT.catalogVersion,
  catalogHash: BOOT_FINGERPRINT.catalogHash,
  modelId: MODEL_CONFIG.model,
  systemPromptHash: BOOT_FINGERPRINT.systemPromptHash,
});

export interface SystemIntegrity {
  ok: boolean;
  artifacts: IntegrityReport;
  evalSet: EvalSetIntegrityReport;
  boot: ArtifactFingerprint;
}

/**
 * Verifies that the production artifacts still match what this process booted
 * with, and that the evaluation set still matches its committed manifest.
 */
export function verifyArtifactIntegrity(now: number = Date.now()): SystemIntegrity {
  const artifacts = compareFingerprints(BOOT_FINGERPRINT, snapshot(now));
  const evalSet = verifyEvalSetIntegrity();
  return {
    ok: artifacts.ok && evalSet.ok,
    artifacts,
    evalSet,
    boot: BOOT_FINGERPRINT,
  };
}
