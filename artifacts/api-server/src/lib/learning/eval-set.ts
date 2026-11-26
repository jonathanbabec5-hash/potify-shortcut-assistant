/**
 * Immutable evaluation set.
 *
 * An evaluation set is only meaningful if it cannot be edited to make a failing
 * candidate pass. Three mechanisms, because each catches a different mistake:
 *
 *  1. **Runtime freeze.** `EVAL_SET` is deep-frozen, so code cannot mutate a
 *     case in memory during a benchmark run.
 *  2. **Content manifest.** Every registered case has a committed hash in
 *     `EVAL_SET_MANIFEST`. Editing a registered case changes its hash and
 *     `verifyEvalSetIntegrity` reports it as mutated — caught by a test, in
 *     review, before it can influence a promotion decision.
 *  3. **Append-only policy.** Adding a new case is allowed and expected (the
 *     set should grow). Removing or altering one is a violation. Growing the
 *     set is how coverage improves; rewriting it is how benchmarks get gamed.
 *
 * To add a case: append it to REGRESSION_CASES, run the eval-set test, and copy
 * the printed hash into the manifest in the same commit. The two-step is
 * deliberate friction — it makes "I changed the benchmark" visible in a diff.
 */

import { createHash } from "node:crypto";
import { REGRESSION_CASES, type RegressionCase } from "../shortcuts/regression";

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Content hash over the parts of a case that define what is being tested.
 *
 * Comments and formatting are excluded by construction (we hash the parsed
 * values, not the source), so reformatting the file does not trip the manifest,
 * but changing an expectation does.
 */
export function hashCase(c: RegressionCase): string {
  const canonical = JSON.stringify({
    id: c.id,
    description: c.description,
    intentChecklist: c.intentChecklist.map((i) => ({
      id: i.id,
      description: i.description,
      category: i.category,
    })),
    expectedActionSequence: c.expectedActionSequence,
    expectedControlFlowDepth: c.expectedControlFlowDepth,
    assertions: c.assertions.map((a) => ({ label: a.label, predicate: a.predicate })),
    // `JSON.stringify` drops undefined properties, so cases registered before
    // this field existed hash exactly as they did before — while a case that
    // *does* set it has that expectation pinned like any other. Flipping
    // `mustRefuse` on a registered case is the highest-leverage way to fake a
    // pass, so it must be inside the hash.
    mustRefuse: c.mustRefuse,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// ── Committed manifest ────────────────────────────────────────────────────────

/**
 * id → content hash for every case that has been registered.
 *
 * DO NOT edit an existing entry to silence a failing integrity check. A
 * mismatch means a locked expectation was changed; either revert the change or
 * register a NEW case id and leave the original intact.
 */
export const EVAL_SET_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
  "RC-001": "492e931d143935b064a9c5d99cdea794",
  "RC-002": "3044bc5e58c410851dffc3065376113b",
  "RC-003": "26b44de8cb6f19b43993db1df976b7eb",
});

// ── Frozen set ────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** The evaluation set. Deep-frozen: mutation attempts throw in strict mode. */
export const EVAL_SET: readonly RegressionCase[] = deepFreeze(REGRESSION_CASES);

// ── Integrity ─────────────────────────────────────────────────────────────────

export interface EvalSetIntegrityReport {
  ok: boolean;
  /** Registered cases whose content no longer matches the manifest. */
  mutated: Array<{ id: string; expected: string; actual: string }>;
  /** Cases in the manifest that no longer exist in the set. */
  removed: string[];
  /** Cases present in the set but absent from the manifest. */
  unregistered: Array<{ id: string; hash: string }>;
  /** Duplicate ids — an id must never be reused, even after removal. */
  duplicateIds: string[];
  caseCount: number;
}

export function verifyEvalSetIntegrity(
  cases: readonly RegressionCase[] = EVAL_SET,
  manifest: Readonly<Record<string, string>> = EVAL_SET_MANIFEST,
): EvalSetIntegrityReport {
  const mutated: EvalSetIntegrityReport["mutated"] = [];
  const unregistered: EvalSetIntegrityReport["unregistered"] = [];
  const duplicateIds: string[] = [];
  const seen = new Set<string>();

  for (const c of cases) {
    if (seen.has(c.id)) duplicateIds.push(c.id);
    seen.add(c.id);

    const actual = hashCase(c);
    const expected = manifest[c.id];
    if (expected === undefined) {
      unregistered.push({ id: c.id, hash: actual });
    } else if (expected !== actual && expected !== "__PENDING__") {
      mutated.push({ id: c.id, expected, actual });
    }
  }

  const removed = Object.keys(manifest).filter((id) => !seen.has(id));

  return {
    ok:
      mutated.length === 0 &&
      removed.length === 0 &&
      unregistered.length === 0 &&
      duplicateIds.length === 0,
    mutated,
    removed,
    unregistered,
    duplicateIds,
    caseCount: cases.length,
  };
}

export class EvalSetIntegrityError extends Error {
  readonly report: EvalSetIntegrityReport;
  constructor(report: EvalSetIntegrityReport) {
    const parts: string[] = [];
    if (report.mutated.length > 0) {
      parts.push(
        `mutated: ${report.mutated.map((m) => `${m.id} (expected ${m.expected}, got ${m.actual})`).join("; ")}`,
      );
    }
    if (report.removed.length > 0) parts.push(`removed: ${report.removed.join(", ")}`);
    if (report.unregistered.length > 0) {
      parts.push(
        `unregistered: ${report.unregistered.map((u) => `${u.id} (add hash ${u.hash} to EVAL_SET_MANIFEST)`).join("; ")}`,
      );
    }
    if (report.duplicateIds.length > 0) {
      parts.push(`duplicate ids: ${report.duplicateIds.join(", ")}`);
    }
    super(`Evaluation set integrity violated — ${parts.join(" | ")}`);
    this.name = "EvalSetIntegrityError";
    this.report = report;
  }
}

/**
 * Hard gate. Any benchmark or promotion run must call this first: a benchmark
 * measured against a tampered set carries no information.
 */
export function assertEvalSetIntegrity(): void {
  const report = verifyEvalSetIntegrity();
  if (!report.ok) throw new EvalSetIntegrityError(report);
}

/** Stable hash of the whole set — recorded alongside every benchmark result. */
export function evalSetFingerprint(
  cases: readonly RegressionCase[] = EVAL_SET,
): string {
  const ids = [...cases].map((c) => `${c.id}:${hashCase(c)}`).sort();
  return createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 32);
}
