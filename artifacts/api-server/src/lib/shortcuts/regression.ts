/**
 * Regression case registry for the POTIFY Shortcut Studio generation pipeline.
 *
 * Each RegressionCase defines:
 *  - The original user description (immutable once registered)
 *  - A locked intent checklist that every generated shortcut must satisfy
 *  - The expected action-identifier sequence (order-sensitive)
 *  - The required control-flow nesting depth
 *  - Assertions the pipeline must pass before the case is marked green
 *
 * Cases here are the authoritative specification for Task #15's
 * six-stage reasoning pipeline. The pipeline must produce a shortcut that
 * passes ALL assertions for EACH case before it is considered production-ready.
 *
 * Rationale for locked intent checklists:
 *   ShortcutsBench (2024) showed that LLMs hallucinate action identifiers at
 *   high rates and that multi-conditional workflows have near-zero accuracy
 *   with compact prompting. Locking the expected sequence forces the pipeline
 *   to produce the precise plist structure Apple requires, not a plausible-
 *   looking but incorrect approximation.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntentChecklistItem {
  /** Short identifier used in assertion messages. */
  id: string;
  /** Human-readable description of what this item checks. */
  description: string;
  /**
   * Category of the check:
   *   "condition"  — the shortcut must test this condition
   *   "action"     — the shortcut must perform this real (non-Comment) action
   *   "structure"  — plist structural requirement (nesting, grouping, etc.)
   */
  category: "condition" | "action" | "structure";
}

export interface RegressionCase {
  /**
   * Unique identifier for this regression case.
   * Never reuse an ID even if the case is removed.
   */
  id: string;

  /** Original user description — must not be modified after registration. */
  description: string;

  /**
   * Locked intent checklist. The pipeline must satisfy ALL items.
   * A "satisfied" item means:
   *   "condition" — at least one non-Comment action in the output implements
   *                 this logical check (e.g. a Conditional comparing distance
   *                 to a threshold, or comparing time to sunrise/sunset).
   *   "action"    — at least one non-Comment action performs this real effect
   *                 (e.g. a HomeKit action that sets a characteristic).
   *   "structure" — the plist has the required structural property (nesting
   *                 depth, grouping, etc.).
   */
  intentChecklist: IntentChecklistItem[];

  /**
   * Expected action-identifier sequence (order-sensitive, exact match).
   * Control-flow openers/closers must appear at the correct nesting depth.
   * Comments are NOT permitted to substitute for any identifier in this list.
   */
  expectedActionSequence: string[];

  /**
   * Maximum nesting depth of control-flow blocks.
   * 1 = a single If; 2 = an If inside an If; 3 = triple-nested, etc.
   * The pipeline must produce a plist with exactly this depth — not shallower
   * (capability lost) and not deeper (unnecessary complexity).
   */
  expectedControlFlowDepth: number;

  /**
   * Concrete assertions the generated shortcut must pass.
   * Each assertion is a deterministic predicate that can be evaluated without
   * calling the LLM. The six-stage pipeline evaluates these before returning.
   */
  assertions: Array<{
    /** Short human-readable label for the assertion. */
    label: string;
    /**
     * The assertion as a predicate description.
     * Task #15 will implement actual evaluator functions; this string is the
     * canonical specification the evaluator is built from.
     */
    predicate: string;
  }>;

  /**
   * When true, the ONLY correct outcome is that no shortcut is produced.
   *
   * Every other case asks "did it build the right thing". These ask the opposite
   * question — "did it decline to build something it had no basis for" — and a
   * suite made only of the first kind rewards a model that always guesses.
   * Refusing well is a capability, and an unmeasured capability regresses.
   *
   * `expectedActionSequence` and `expectedControlFlowDepth` are meaningless for
   * these cases and are ignored by the benchmark harness; register them as `[]`
   * and `0`.
   */
  mustRefuse?: boolean;
}

// ── Regression case registry ──────────────────────────────────────────────────

/**
 * RC-001 — Home / Distance / Sunset / Lights
 *
 * The canonical multi-conditional regression case.
 *
 * Why this case exists:
 *   ShortcutsBench (2024) and the WorkflowBench paper (NeurIPS 2024) both
 *   identify multi-condition If-inside-If workflows as the hardest category
 *   for LLMs to generate correctly. The home/sunset/lights scenario requires:
 *     (a) a proximity check (Get Distance + If)
 *     (b) a time-of-day check inside that branch (Get Sunrise/Sunset + If)
 *     (c) a HomeKit read and write inside that inner branch
 *   This is 3 nested If blocks. iOS Shortcuts cannot express "A AND B AND C"
 *   as a single flat condition — the plist format only supports a single
 *   condition per If action. The pipeline must produce the nested form.
 *
 * Expected plist structure (identifiers, order-sensitive):
 *   1.  is.workflow.actions.getlocation         (get current location)
 *   2.  is.workflow.actions.getdistance                (distance to home)
 *   3.  is.workflow.actions.conditional                (If distance < threshold, g=G1)
 *   4.    is.workflow.actions.getsunrisesunset          (get sunset time)
 *   5.    is.workflow.actions.conditional               (If current time > sunset, g=G2)
 *   6.      [HomeKit read characteristic action]        (check lights off)
 *   7.      is.workflow.actions.conditional             (If lights are off, g=G3)
 *   8.        [HomeKit set characteristic action]       (turn on + warm color)
 *   9.      is.workflow.actions.conditional.end         (end G3)
 *   10.   is.workflow.actions.conditional.otherwise     (otherwise — daytime, g=G2)
 *   11.   is.workflow.actions.conditional.end           (end G2)
 *   12. is.workflow.actions.conditional.otherwise       (otherwise — not near home, g=G1)
 *   13. is.workflow.actions.conditional.end             (end G1)
 */
export const REGRESSION_CASES: RegressionCase[] = [
  {
    id: "RC-001",
    description:
      "Check if I am within 1 km of home, it is after sunset, and the living room lights are off; if so, turn on the lights and set them to a warm color. Otherwise do nothing.",

    intentChecklist: [
      {
        id: "IC-001-proximity",
        description:
          "A proximity / distance check compares current location to a home address or saved location using Get Distance (is.workflow.actions.getdistance) or Get Current Location + an If condition.",
        category: "condition",
      },
      {
        id: "IC-001-sunset",
        description:
          "A time-of-day check determines whether the current time is after sunset using Get Sunrise and Sunset (is.workflow.actions.getsunrisesunset) and compares it to the current date/time.",
        category: "condition",
      },
      {
        id: "IC-001-lights-state",
        description:
          "The current state of the living room lights is read via a HomeKit action (e.g. Get Characteristic or equivalent) before deciding whether to turn them on.",
        category: "condition",
      },
      {
        id: "IC-001-lights-on",
        description:
          "The living room lights are turned on using a real HomeKit action (not a Comment). The action must set the On/Off characteristic to true.",
        category: "action",
      },
      {
        id: "IC-001-warm-color",
        description:
          "The light color temperature or hue is set to a warm value using a real HomeKit action. A second Set Characteristic call or a combined scene action is acceptable.",
        category: "action",
      },
      {
        id: "IC-001-nesting",
        description:
          "The three conditions are implemented as three nested If blocks (proximity outer, sunset middle, lights-off inner). iOS Shortcuts cannot express compound AND conditions in a single If action.",
        category: "structure",
      },
    ],

    // Identifiers only — GroupingIdentifiers are dynamic UUIDs and are not
    // tested here. HomeKit identifiers are marked with [HOMEKIT] because the
    // catalog does not list them; the pipeline must still produce valid
    // identifiers. A [HOMEKIT] placeholder in this list means "any non-Comment
    // action whose identifier matches /homekit|characteristic|accessory/i".
    expectedActionSequence: [
      "is.workflow.actions.getlocation",
      "is.workflow.actions.getdistance",
      "is.workflow.actions.conditional",         // outer If: distance < 1 km
      "is.workflow.actions.getsunrisesunset",
      "is.workflow.actions.conditional",         // middle If: time > sunset
      "[HOMEKIT:read]",                          // read lights state
      "is.workflow.actions.conditional",         // inner If: lights are off
      "[HOMEKIT:set-on]",                        // turn on
      "[HOMEKIT:set-color]",                     // warm color (may be same call)
      "is.workflow.actions.conditional.end",     // end inner If
      "is.workflow.actions.conditional.otherwise", // middle Otherwise (daytime)
      "is.workflow.actions.conditional.end",     // end middle If
      "is.workflow.actions.conditional.otherwise", // outer Otherwise (not near home)
      "is.workflow.actions.conditional.end",     // end outer If
    ],

    expectedControlFlowDepth: 3,

    assertions: [
      {
        label: "No Comment substitutions",
        predicate:
          "completionStatus.satisfied === true — the completion gate must pass, meaning no Comment action substitutes for a required capability.",
      },
      {
        label: "Proximity check present",
        predicate:
          "At least one action with identifier matching /getdistance|getlocation/i is present in WFWorkflowActions.",
      },
      {
        label: "Sunset check present",
        predicate:
          "At least one action with identifier 'is.workflow.actions.getsunrisesunset' is present.",
      },
      {
        label: "HomeKit actions present",
        predicate:
          "At least one action with an identifier matching /homekit|characteristic|accessory/i is present (not a Comment).",
      },
      {
        label: "Triple-nested If structure",
        predicate:
          "There are exactly 3 'is.workflow.actions.conditional' openers and exactly 3 'is.workflow.actions.conditional.end' closers, forming a 3-deep nesting.",
      },
      {
        label: "No zero-executable-actions failure",
        predicate:
          "The count of non-Comment actions (executableCount) is > 0 — Gate 0b in checkCompletion must not fire.",
      },
      {
        label: "Valid GroupingIdentifiers",
        predicate:
          "Every 'is.workflow.actions.conditional' opener has a GroupingIdentifier. Every 'is.workflow.actions.conditional.end' and 'is.workflow.actions.conditional.otherwise' shares the GroupingIdentifier of its opener.",
      },
    ],
  },

  /**
   * RC-002 — Capability the catalog does not have
   *
   * Every case before this one measures whether the pipeline builds the right
   * thing. None measured whether it declines to build the wrong thing, so a
   * variant that improved by guessing more confidently would have scored better.
   *
   * There is no action in the catalog that posts to a social network. The only
   * acceptable outcomes are a clarification or an explicit refusal. Inventing a
   * plausible-looking identifier, or substituting a Comment that describes the
   * step, are both failures — a shortcut that imports and silently does nothing
   * is worse than one that was never offered.
   */
  {
    id: "RC-002",
    description: "Post my latest photo to my Mastodon account with the caption 'from my phone'.",
    mustRefuse: true,
    intentChecklist: [
      {
        id: "IC-002-refuse",
        description:
          "Recognises that no catalogued action can post to Mastodon and does not generate a shortcut.",
        category: "structure",
      },
      {
        id: "IC-002-no-invention",
        description:
          "Does not emit an invented identifier such as is.workflow.actions.mastodon.post.",
        category: "structure",
      },
    ],
    expectedActionSequence: [],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "No shortcut returned",
        predicate:
          "The pipeline returns a clarification or refusal; no importable plist is produced.",
      },
      {
        label: "No Comment substitution",
        predicate:
          "If any output exists at all, it does not contain a Comment action standing in for the posting step.",
      },
    ],
  },

  /**
   * RC-003 — Required parameter the user never supplied
   *
   * "Send a message" names a real, catalogued action whose recipient and body are
   * both required and neither of which the user gave. The tempting behaviour is
   * to emit the action with an empty or invented value, which produces a
   * shortcut that imports cleanly and then fails or messages the wrong person.
   *
   * Asking is the correct answer. This case exists so that "asks instead of
   * guessing" is a measured property rather than an aspiration.
   */
  {
    id: "RC-003",
    description: "Send a message.",
    mustRefuse: true,
    intentChecklist: [
      {
        id: "IC-003-clarify",
        description: "Asks for the recipient and the message body instead of generating.",
        category: "structure",
      },
      {
        id: "IC-003-no-placeholder",
        description:
          "Does not fill the required recipient or body with a placeholder or invented literal.",
        category: "structure",
      },
    ],
    expectedActionSequence: [],
    expectedControlFlowDepth: 0,
    assertions: [
      {
        label: "Clarification requested",
        predicate: "The pipeline reports the missing required parameters rather than returning a plist.",
      },
      {
        label: "No invented recipient",
        predicate:
          "No output contains a concrete recipient or body value, since the request supplied neither.",
      },
    ],
  },
];
