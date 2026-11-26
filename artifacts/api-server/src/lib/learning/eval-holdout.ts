/**
 * Held-out evaluation set.
 *
 * A second, separate suite from `REGRESSION_CASES`. Separate on purpose.
 *
 * `REGRESSION_CASES` is the specification the pipeline was built against — it
 * is, in effect, training data for the design. Measuring a candidate on the
 * cases it was written to satisfy tells you almost nothing about whether it
 * generalises. These cases are never used to guide implementation; they exist
 * only to be run at promotion time, which is the only way a benchmark number
 * means anything.
 *
 * Consequences of that, both deliberate:
 *
 *  - **No pass assertions in tests.** The suite is checked for *integrity*, not
 *    for passing. A test that required these to pass would turn them into a
 *    development target and destroy the property that makes them useful.
 *  - **Breadth over depth.** RC-001 covers deeply-nested multi-condition
 *    workflows thoroughly. These cover the territory it does not: flat
 *    sequences, loops, list selection, web/JSON parsing, media, and clipboard —
 *    at depths 0, 1, and 2.
 *
 * Same append-only rule as the main set: adding a case is expected, editing or
 * removing one is a violation.
 */

import { hashCase, type EvalSetIntegrityReport } from "./eval-set";
import type { RegressionCase } from "../shortcuts/regression";

// ── Cases ─────────────────────────────────────────────────────────────────────

const HOLDOUT_CASES: RegressionCase[] = [
  {
    id: "HO-001",
    description:
      "Every morning, if my phone battery is above 50 percent, play my Focus playlist, otherwise remind me to plug it in.",
    intentChecklist: [
      {
        id: "IC-HO-001-battery",
        description: "Reads the current battery level.",
        category: "condition",
      },
      {
        id: "IC-HO-001-threshold",
        description: "Compares battery level against 50 percent.",
        category: "condition",
      },
      {
        id: "IC-HO-001-play",
        description: "Plays the Focus playlist on the true branch.",
        category: "action",
      },
      {
        id: "IC-HO-001-remind",
        description: "Shows a charging reminder on the false branch.",
        category: "action",
      },
      {
        id: "IC-HO-001-else",
        description: "Uses a single If with an Otherwise branch, not two separate Ifs.",
        category: "structure",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.getbatterylevel",
      "is.workflow.actions.conditional",
      "is.workflow.actions.playmusic",
      "is.workflow.actions.conditional",
      "is.workflow.actions.notification",
      "is.workflow.actions.conditional",
    ],
    expectedControlFlowDepth: 1,
    assertions: [
      {
        label: "Otherwise branch present",
        predicate:
          "Exactly three conditional actions share one GroupingIdentifier with WFControlFlowMode 0, 1, and 2.",
      },
      {
        label: "Both branches act",
        predicate: "Each branch contains at least one non-Comment action.",
      },
    ],
  },
  {
    id: "HO-002",
    description:
      "Take the photos I shot today, resize each one to 1000 pixels wide, and save them back to my camera roll.",
    intentChecklist: [
      {
        id: "IC-HO-002-source",
        description: "Fetches today's photos.",
        category: "action",
      },
      {
        id: "IC-HO-002-loop",
        description: "Iterates over the fetched photos rather than acting on only one.",
        category: "structure",
      },
      {
        id: "IC-HO-002-resize",
        description: "Resizes each photo to 1000 pixels wide.",
        category: "action",
      },
      {
        id: "IC-HO-002-save",
        description: "Saves each resized photo.",
        category: "action",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.getlastphoto",
      "is.workflow.actions.repeat.each",
      "is.workflow.actions.image.resize",
      "is.workflow.actions.savetocameraroll",
      "is.workflow.actions.repeat.each",
    ],
    expectedControlFlowDepth: 1,
    assertions: [
      {
        label: "Loop body operates on the repeat item",
        predicate:
          "The resize action's input binds to the Repeat Item variable, not to the original photo list.",
      },
      {
        label: "Loop closed",
        predicate: "Repeat opener and closer share a GroupingIdentifier.",
      },
    ],
  },
  {
    id: "HO-003",
    description:
      "Ask me whether I'm heading Home, to Work, or to the Gym, then open directions to whichever I choose.",
    intentChecklist: [
      {
        id: "IC-HO-003-prompt",
        description: "Presents the three destinations as a choice.",
        category: "action",
      },
      {
        id: "IC-HO-003-directions",
        description: "Requests directions to the chosen destination.",
        category: "action",
      },
      {
        id: "IC-HO-003-flat",
        description:
          "Uses list selection rather than branching — no If is needed when the choice is the value.",
        category: "structure",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.choosefromlist",
      "is.workflow.actions.getdirections",
      "is.workflow.actions.openurl",
    ],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "No spurious branching",
        predicate: "The plist contains no conditional actions.",
      },
      {
        label: "Choice feeds directions",
        predicate: "The directions action binds its destination to the Chosen Item variable.",
      },
    ],
  },
  {
    id: "HO-004",
    description:
      "Fetch the forecast from my weather endpoint and read the temperature out loud.",
    intentChecklist: [
      {
        id: "IC-HO-004-fetch",
        description: "Performs an HTTP request to the endpoint.",
        category: "action",
      },
      {
        id: "IC-HO-004-parse",
        description: "Parses the response as a dictionary.",
        category: "action",
      },
      {
        id: "IC-HO-004-extract",
        description: "Extracts the temperature value by key.",
        category: "action",
      },
      {
        id: "IC-HO-004-speak",
        description: "Speaks the extracted value.",
        category: "action",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.downloadurl",
      "is.workflow.actions.detect.dictionary",
      "is.workflow.actions.getvalueforkey",
      "is.workflow.actions.speaktext",
    ],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "Parse before access",
        predicate:
          "The get-value action appears after the dictionary detection and binds to its output.",
      },
      {
        label: "No invented endpoint",
        predicate:
          "The URL parameter is left as a clarification placeholder rather than a guessed hostname.",
      },
    ],
  },
  {
    id: "HO-005",
    description:
      "Go through my reminders due today and send me a notification for each one that's marked high priority.",
    intentChecklist: [
      {
        id: "IC-HO-005-filter",
        description: "Filters reminders down to those due today.",
        category: "action",
      },
      {
        id: "IC-HO-005-loop",
        description: "Iterates over the filtered reminders.",
        category: "structure",
      },
      {
        id: "IC-HO-005-priority",
        description: "Tests each reminder's priority inside the loop.",
        category: "condition",
      },
      {
        id: "IC-HO-005-notify",
        description: "Notifies only for high-priority reminders.",
        category: "action",
      },
      {
        id: "IC-HO-005-nesting",
        description: "The conditional is nested inside the repeat, giving depth 2.",
        category: "structure",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.filter.reminders",
      "is.workflow.actions.repeat.each",
      "is.workflow.actions.conditional",
      "is.workflow.actions.notification",
      "is.workflow.actions.conditional",
      "is.workflow.actions.repeat.each",
    ],
    expectedControlFlowDepth: 2,
    assertions: [
      {
        label: "Condition inside loop",
        predicate:
          "The conditional opener appears after the repeat opener and its closer before the repeat closer.",
      },
      {
        label: "Filter not simulated by a branch",
        predicate:
          "Due-today filtering happens in the filter action's parameters, not as an extra conditional.",
      },
    ],
  },
  {
    id: "HO-006",
    description: "Wait ten seconds, then copy today's date to my clipboard and show it to me.",
    intentChecklist: [
      {
        id: "IC-HO-006-delay",
        description: "Waits ten seconds before doing anything else.",
        category: "action",
      },
      {
        id: "IC-HO-006-date",
        description: "Obtains the current date.",
        category: "action",
      },
      {
        id: "IC-HO-006-clipboard",
        description: "Places the formatted date on the clipboard.",
        category: "action",
      },
      {
        id: "IC-HO-006-show",
        description: "Displays the result to the user.",
        category: "action",
      },
    ],
    expectedActionSequence: [
      "is.workflow.actions.delay",
      "is.workflow.actions.date",
      "is.workflow.actions.format.date",
      "is.workflow.actions.setclipboard",
      "is.workflow.actions.showresult",
    ],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "Ordering preserved",
        predicate: "The delay is the first action, matching the stated sequence.",
      },
      {
        label: "Literal delay value",
        predicate: "The delay parameter is the number 10, not a placeholder.",
      },
    ],
  },

  /**
   * HO-007 — Capability the catalog does not have (held-out variant)
   *
   * Same class of question as RC-002, deliberately in a different domain so that
   * passing RC-002 by pattern-matching on the word "Mastodon" does not transfer.
   * Robot-vacuum control has no catalogued action.
   */
  {
    id: "HO-007",
    description: "Start my Roomba and have it vacuum the kitchen, then tell me when it's done.",
    mustRefuse: true,
    intentChecklist: [
      {
        id: "IC-HO-007-refuse",
        description:
          "Recognises that no catalogued action controls a robot vacuum and declines to generate.",
        category: "structure",
      },
      {
        id: "IC-HO-007-no-invention",
        description: "Does not invent a vacuum-control identifier or a third-party app action.",
        category: "structure",
      },
    ],
    expectedActionSequence: [],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "No shortcut returned",
        predicate: "A clarification or refusal is returned; no importable plist is produced.",
      },
      {
        label: "Partial completion not offered",
        predicate:
          "The notification half is not returned on its own as though the request were satisfied.",
      },
    ],
  },

  /**
   * HO-008 — Required parameter the user never supplied (held-out variant)
   *
   * Same class as RC-003, different action and different missing fields, so the
   * behaviour has to generalise rather than memorise "Send a message".
   */
  {
    id: "HO-008",
    description: "Add it to my calendar.",
    mustRefuse: true,
    intentChecklist: [
      {
        id: "IC-HO-008-clarify",
        description: "Asks what the event is, and when, instead of generating.",
        category: "structure",
      },
      {
        id: "IC-HO-008-referent",
        description:
          'Recognises that "it" has no referent in this request and does not guess one.',
        category: "structure",
      },
    ],
    expectedActionSequence: [],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "Clarification requested",
        predicate: "The pipeline asks for the event title and date rather than returning a plist.",
      },
      {
        label: "No invented event",
        predicate: "No output contains a concrete event title or date.",
      },
    ],
  },
];

// ── Committed manifest ────────────────────────────────────────────────────────

/**
 * id → content hash. Same rule as the main manifest: never edit an entry to
 * silence a mismatch. A mismatch means a held-out expectation changed, which is
 * precisely the tampering this file exists to prevent.
 */
export const HOLDOUT_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
  "HO-001": "25a46afc24fdf51af068f4e8964ddc34",
  "HO-002": "6abe661d53ecf20360d9f93fa427aaa7",
  "HO-003": "a5d3b1e5cf5dc2e831c563c1dbda230b",
  "HO-004": "16f139d5932eae6489beaa0a5f29ecaa",
  "HO-005": "3bf17cad82a0c21c11ddc29518b35f90",
  "HO-006": "844074c1f80dcc8f8c1d4fe20e26e710",
  "HO-007": "61f78e364001b4935a1018e87d7a3326",
  "HO-008": "02a8a300ab2618cb5ac00116629f7b55",
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

export const HOLDOUT_SET: readonly RegressionCase[] = deepFreeze(HOLDOUT_CASES);

// ── Integrity ─────────────────────────────────────────────────────────────────

export function verifyHoldoutIntegrity(
  cases: readonly RegressionCase[] = HOLDOUT_SET,
  manifest: Readonly<Record<string, string>> = HOLDOUT_MANIFEST,
): EvalSetIntegrityReport {
  const mutated: Array<{ id: string; expected: string; actual: string }> = [];
  const removed: string[] = [];
  const unregistered: Array<{ id: string; hash: string }> = [];
  const duplicateIds: string[] = [];

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) duplicateIds.push(c.id);
    seen.add(c.id);

    const actual = hashCase(c);
    const expected = manifest[c.id];
    if (expected === undefined) {
      unregistered.push({ id: c.id, hash: actual });
      continue;
    }
    if (actual !== expected) mutated.push({ id: c.id, expected, actual });
  }

  for (const id of Object.keys(manifest)) {
    if (!seen.has(id)) removed.push(id);
  }

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

export function assertHoldoutIntegrity(): void {
  const report = verifyHoldoutIntegrity();
  if (report.ok) return;

  const problems: string[] = [];
  if (report.mutated.length > 0) {
    problems.push(
      `mutated: ${report.mutated.map((m) => `${m.id} (expected ${m.expected}, got ${m.actual})`).join(", ")}`,
    );
  }
  if (report.removed.length > 0) problems.push(`removed: ${report.removed.join(", ")}`);
  if (report.unregistered.length > 0) {
    problems.push(
      `unregistered: ${report.unregistered.map((u) => `${u.id} (hash ${u.hash})`).join(", ")}`,
    );
  }
  if (report.duplicateIds.length > 0) {
    problems.push(`duplicate ids: ${report.duplicateIds.join(", ")}`);
  }

  throw new Error(`Held-out evaluation set integrity violation — ${problems.join("; ")}.`);
}

export function holdoutFingerprint(cases: readonly RegressionCase[] = HOLDOUT_SET): string {
  return cases
    .map((c) => `${c.id}:${hashCase(c)}`)
    .sort()
    .join("|");
}
