/**
 * Wildcard identifiers in expected action sequences.
 *
 * ## Why this is its own module
 *
 * Two callers need this convention: the benchmark harness, which scores an
 * expected sequence against real output, and the coverage classifier, which
 * decides whether a case is scoreable at all. The harness lives under
 * `lib/learning/training/`, which an import-graph test forbids the request path
 * from reaching — so the coverage classifier cannot import it, because coverage
 * is reported by an operator endpoint that *is* on the request path.
 *
 * Keeping the convention here means both sides share one definition. The
 * alternative — a second copy for the serving side — is how a wildcard ends up
 * recognised by the classifier and unrecognised by the scorer, which would report
 * a case as runnable and then fail it forever.
 *
 * ## The convention
 *
 * `[HOMEKIT:set-on]` in an expected sequence means "any non-Comment action whose
 * identifier matches the HOMEKIT family pattern". It exists because HomeKit
 * actions are not catalogued individually and their real identifiers vary by
 * accessory and iOS version, so pinning one would make the case wrong rather
 * than strict.
 *
 * This convention was documented on `RegressionCase.expectedActionSequence` and
 * honoured nowhere: the comparison used `!==`, so a case containing a wildcard
 * could not match any real output and was guaranteed to fail forever. A
 * permanently-failing case pins champion and challenger to the same score, which
 * silently zeroes the pass-rate delta the improvement gate depends on — the gate
 * cannot fire, and it reads as "the candidate did not help".
 */

const PLACEHOLDER_FAMILIES: Readonly<Record<string, RegExp>> = Object.freeze({
  HOMEKIT: /homekit|characteristic|accessory/i,
});

const PLACEHOLDER_TOKEN = /^\[([A-Z]+):[a-z-]+\]$/;

/** Parses `[HOMEKIT:set-on]`. Returns null for an ordinary identifier. */
export function placeholderFamilyOf(token: string): string | null {
  const match = PLACEHOLDER_TOKEN.exec(token);
  return match ? match[1]! : null;
}

export function identifierMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;

  const family = placeholderFamilyOf(expected);
  if (family === null) return expected === actual;

  const pattern = PLACEHOLDER_FAMILIES[family];
  if (pattern === undefined) {
    // Fail loudly. Treating an unrecognised placeholder as "matches anything"
    // would turn a typo into a case that always passes.
    throw new Error(
      `Unknown placeholder family "${family}" in an expected action sequence. ` +
        `Known families: ${Object.keys(PLACEHOLDER_FAMILIES).join(", ")}.`,
    );
  }
  return pattern.test(actual);
}

/** Family names, for error messages and coverage reporting. */
export function knownPlaceholderFamilies(): readonly string[] {
  return Object.keys(PLACEHOLDER_FAMILIES);
}
