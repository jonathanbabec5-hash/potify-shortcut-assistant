/**
 * Whether an evaluation case can actually be scored against today's catalog.
 *
 * ## The problem this exists to make visible
 *
 * An evaluation case names the action identifiers it expects. If the catalog does
 * not contain one of them, the pipeline cannot emit it, so the case fails on
 * every run — for the champion and the challenger equally. That is much worse
 * than a missing test:
 *
 *   - both variants score identically on it, so it contributes exactly zero to
 *     the pass-rate delta the improvement gate is built on;
 *   - the failure looks like a model shortcoming rather than a suite defect;
 *   - if *every* case is in that state, the delta is always 0.0000, the gate can
 *     never fire, and the whole promotion apparatus is inert while appearing to
 *     work.
 *
 * So an unscoreable case must be reported as **cannot run**, never counted as a
 * failure. "We measured this and it failed" and "we could not measure this" are
 * different claims and only one of them is honest here.
 *
 * ## Why the fix is not to edit the cases
 *
 * Both suites are append-only and hash-pinned precisely so a failing expectation
 * cannot be rewritten into a passing one. Editing a case to match the catalog is
 * the exact tampering the manifest prevents. The legitimate repairs are to grow
 * the catalog or to register a new case; either way the original stays put and
 * this module keeps telling the truth about it in the meantime.
 *
 * This module deliberately lives outside `training/`: the benchmark harness has
 * no import path to the catalog, and giving it one to support this check would
 * cost more than the check is worth. The caller classifies, then hands the
 * harness only what it can score.
 */

import { getAllActions } from "../shortcuts/catalog";
// Imported from the neutral module, not from the training subtree: coverage is
// reported by an operator endpoint on the request path, and an import-graph test
// forbids that path from reaching training code.
import { placeholderFamilyOf } from "./placeholder-families";
import type { RegressionCase } from "../shortcuts/regression";

export interface UnrunnableCase {
  id: string;
  /** Identifiers the case expects that the catalog does not define. */
  unknownIdentifiers: string[];
}

export interface CoverageReport {
  /** Cases every expected identifier of which exists (or is a wildcard). */
  runnable: readonly RegressionCase[];
  unrunnable: readonly UnrunnableCase[];
  catalogSize: number;
}

/**
 * Splits a suite into what can be scored and what cannot.
 *
 * Wildcard tokens such as `[HOMEKIT:set-on]` are not looked up — by convention
 * they match a family of identifiers the catalog is not required to list, and
 * `compareCase` resolves them at comparison time.
 *
 * Cases marked `mustRefuse` are always runnable: the expected outcome is that
 * nothing is generated, so there is no identifier to resolve.
 */
export function classifyCoverage(cases: readonly RegressionCase[]): CoverageReport {
  const known = new Set(getAllActions().map((a) => a.identifier));

  const runnable: RegressionCase[] = [];
  const unrunnable: UnrunnableCase[] = [];

  for (const testCase of cases) {
    if (testCase.mustRefuse === true) {
      runnable.push(testCase);
      continue;
    }

    const unknown = [
      ...new Set(
        testCase.expectedActionSequence.filter(
          (id) => placeholderFamilyOf(id) === null && !known.has(id),
        ),
      ),
    ].sort();

    if (unknown.length === 0) runnable.push(testCase);
    else unrunnable.push({ id: testCase.id, unknownIdentifiers: unknown });
  }

  return { runnable, unrunnable, catalogSize: known.size };
}

/**
 * Human-readable summary for the training log.
 *
 * Names the missing identifiers, because "3 cases cannot run" is not actionable
 * and the whole point is that someone should be able to act on it.
 */
export function describeCoverage(suite: string, report: CoverageReport): string {
  const lines = [
    `  ${suite}: ${report.runnable.length} runnable, ${report.unrunnable.length} cannot run ` +
      `(catalog has ${report.catalogSize} actions)`,
  ];
  for (const u of report.unrunnable) {
    lines.push(`    ⚠ ${u.id} cannot be scored — catalog is missing: ${u.unknownIdentifiers.join(", ")}`);
  }
  return lines.join("\n");
}
