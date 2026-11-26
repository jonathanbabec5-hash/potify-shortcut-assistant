/**
 * Completion gate — the final correctness check before a shortcut is marked ready.
 *
 * A shortcut is only "ready" when ALL of the following hold:
 *   1. No hard schema errors from the deterministic validator.
 *   2. No Comment action substitutes for a real capability (hollow-text detection).
 *   3. Comments do not dominate the workflow (saturation check).
 *   4. Every capability the user's description explicitly requested maps to at
 *      least one non-Comment executable action in the generated shortcut.
 *
 * Self-contained and side-effect-free. Never modifies prompts, catalogs, or weights.
 */

import type { ShortcutPlist } from "./catalog";
import type { ValidationFinding, ValidationResult } from "./validation";

// ── Public types ──────────────────────────────────────────────────────────────

export type CompletionStatus = "ready" | "incomplete" | "unsupported" | "validation-failed";

export interface CompletionResult {
  /** Whether the shortcut is ready to be stored and offered for import. */
  satisfied: boolean;
  status: CompletionStatus;
  /** Human-readable list of capabilities that could not be built. */
  missingCapabilities: string[];
  /** Action identifiers found in the request but absent from the catalog. */
  unsupportedActions: string[];
  /** Comment-action identifiers that substituted for real capabilities. */
  hollowActions: string[];
  /** All findings that block import — hard schema errors + hollow-action findings. */
  blockingFindings: ValidationFinding[];
}

// ── Hollow-placeholder pattern ────────────────────────────────────────────────
// Conservative: false positives (a real note comment) are a safe/conservative failure.

const HOLLOW_PATTERN =
  /\b(unsupported|not\s+(available|supported|possible|implemented)|placeholder|workaround|note:|cannot|can'?t|can\s+not|instead\s+of|sorry|unable|no\s+(native|built-in|direct)\s+support|requires?\s+a?\s+third.party|this\s+action\s+(is\s+not|isn'?t))\b/i;

// ── Capability-requirement registry ──────────────────────────────────────────

interface CapabilityRequirement {
  label: string;
  /** Matched against the original user description. */
  descriptionPattern: RegExp;
  /**
   * If ANY real (non-Comment) action identifier in the shortcut matches ANY of
   * these patterns, the requirement is considered satisfied.
   */
  actionPatterns: RegExp[];
}

const CAPABILITY_REQUIREMENTS: CapabilityRequirement[] = [
  {
    label: "distance / proximity check",
    descriptionPattern: /\b(within|distance|near|close|proximity|\d+\s*(km|mile|mi|meter|m)\b)/i,
    // The catalog action is `getlocation`; `getcurrentlocation` does not exist.
    // Matching only the latter meant a correctly-built location shortcut failed
    // this capability check and was reported as missing a proximity check.
    actionPatterns: [/getdistance/i, /get(?:current)?location/i],
  },
  {
    label: "sunrise or sunset time",
    descriptionPattern: /\b(sunrise|sunset|dawn|dusk|after\s+dark|before\s+sunrise|after\s+sunset)\b/i,
    actionPatterns: [/getsunrisesunset/i, /sunrise/i, /sunset/i],
  },
  {
    label: "smart home / lights / HomeKit control",
    descriptionPattern:
      /\b(lights?|lamp|bulb|brightness|hue|color\s+temp(erature)?|warm\s+(white|color)|homekit|home\s+(app|automation)|smart\s+(home|plug|switch|light)|thermostat|door\s+lock)\b/i,
    actionPatterns: [
      /homekit/i,
      /controlhome/i,
      /homescene/i,
      /accessory/i,
      /getcharacteristic/i,
      /setcharacteristic/i,
    ],
  },
  {
    label: "send message / SMS / iMessage",
    descriptionPattern: /\b(send\s+(a\s+)?(message|text|sms|imessage)|message\s+someone)\b/i,
    actionPatterns: [/sendmessage/i, /composemessage/i],
  },
  {
    label: "send email",
    descriptionPattern: /\b(send\s+(an?\s+)?email|email\s+someone)\b/i,
    actionPatterns: [/sendemail/i, /composemail/i],
  },
  {
    label: "calendar / scheduling",
    descriptionPattern: /\b(calendar|event|appointment|schedule)\b/i,
    actionPatterns: [/calendar/i, /getupcomingevents/i, /createevent/i],
  },
  {
    label: "weather",
    descriptionPattern: /\b(weather|temperature|forecast|rain|sunny|humidity)\b/i,
    actionPatterns: [/weather/i, /gettemperature/i],
  },
  {
    label: "music or audio playback",
    descriptionPattern:
      /\b(play\s+(music|a?\s*song|playlist|podcast)|stop\s+music|pause\s+music|apple\s+music|spotify)\b/i,
    actionPatterns: [/music/i, /playlist/i, /playmusic/i, /setvolume/i, /nowplaying/i],
  },
  {
    label: "NFC tag",
    descriptionPattern: /\b(nfc|tap\s+(a\s+)?tag|scan\s+(a\s+)?tag)\b/i,
    actionPatterns: [/nfc/i],
  },
  {
    label: "take photo or open camera",
    descriptionPattern: /\b(take\s+a\s+photo|open\s+camera|capture\s+(a\s+)?photo|screenshot)\b/i,
    actionPatterns: [/takephoto/i, /camera/i, /selectphoto/i, /screenshot/i],
  },
];

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param description  Original user description (used for requirement matching).
 * @param shortcut     Generated shortcut plist.
 * @param validation   Result from validateShortcut (must be called first).
 * @returns            CompletionResult — never throws.
 */
export function checkCompletion(
  description: string,
  shortcut: ShortcutPlist,
  validation: ValidationResult,
): CompletionResult {
  const actions = shortcut.WFWorkflowActions ?? [];
  const total = actions.length;

  // ── Gate 0a: hard schema errors block everything ───────────────────────────
  if (validation.hardSchemaErrors.length > 0) {
    return {
      satisfied: false,
      status: "validation-failed",
      missingCapabilities: [],
      unsupportedActions: [],
      hollowActions: [],
      blockingFindings: validation.hardSchemaErrors,
    };
  }

  // ── Gate 0b: zero executable actions ──────────────────────────────────────
  // A shortcut where every action is a Comment (regardless of Comment text and
  // regardless of total count) does nothing on device. This catches:
  //   - A single Comment with benign text ("Step 1") — misses hollow detection
  //     (no HOLLOW_PATTERN match) and misses saturation (total > 1 guard).
  //   - Any all-Comment workflow of any length with no hollow phrases.
  const executableCount = actions.filter(
    (a) => a.WFWorkflowActionIdentifier !== "is.workflow.actions.comment",
  ).length;

  if (executableCount === 0 && total > 0) {
    return {
      satisfied: false,
      status: "incomplete",
      missingCapabilities: [],
      unsupportedActions: [],
      hollowActions: ["is.workflow.actions.comment"],
      blockingFindings: [
        {
          severity: "error",
          source: "completion",
          message: `The shortcut contains ${total === 1 ? "only one action and it is" : `${total} actions that are all`} Comment${total === 1 ? "" : "s"} — no executable steps. Comments are notes only and do nothing on device.`,
          suggestion:
            "The required capabilities could not be built with available iOS Shortcuts actions, or the model produced a placeholder. Import is blocked.",
        },
      ],
    };
  }

  // ── Gate 1: hollow Comment detection ──────────────────────────────────────
  const hollowActionIdentifiers: string[] = [];
  const hollowFindings: ValidationFinding[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.WFWorkflowActionIdentifier !== "is.workflow.actions.comment") continue;
    const params = action.WFWorkflowActionParameters as Record<string, unknown> | undefined;
    const text = String(params?.WFCommentActionText ?? "");
    if (HOLLOW_PATTERN.test(text)) {
      hollowActionIdentifiers.push(action.WFWorkflowActionIdentifier);
      hollowFindings.push({
        severity: "error",
        source: "completion",
        actionIndex: i,
        actionIdentifier: "is.workflow.actions.comment",
        message: `A Comment action was substituted for a required capability: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}". Comments are not executable and do not implement this requirement.`,
        suggestion:
          "This capability cannot be implemented with the current iOS Shortcuts action catalog. The shortcut is incomplete.",
      });
    }
  }

  // ── Gate 2: comment saturation (≥50 % of actions are Comments) ────────────
  if (hollowFindings.length === 0 && total > 1) {
    const commentCount = actions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.comment",
    ).length;
    if (commentCount / total >= 0.5) {
      hollowActionIdentifiers.push("is.workflow.actions.comment");
      hollowFindings.push({
        severity: "error",
        source: "completion",
        message: `${commentCount} of ${total} actions are Comments — the shortcut appears to be a placeholder workflow.`,
        suggestion: "Simplify the request, or check whether the required capabilities are supported by iOS Shortcuts.",
      });
    }
  }

  // ── Gate 3: requirement-vs-action mapping ─────────────────────────────────
  // Only run when no hollow Comments found (hollow detection is a stronger signal).
  const missingCapabilities: string[] = [];
  const requirementFindings: ValidationFinding[] = [];

  if (hollowFindings.length === 0) {
    const realIdentifiers = actions
      .filter((a) => a.WFWorkflowActionIdentifier !== "is.workflow.actions.comment")
      .map((a) => a.WFWorkflowActionIdentifier);

    for (const req of CAPABILITY_REQUIREMENTS) {
      if (!req.descriptionPattern.test(description)) continue;
      const satisfied = req.actionPatterns.some((pat) =>
        realIdentifiers.some((id) => pat.test(id)),
      );
      if (!satisfied) {
        missingCapabilities.push(req.label);
        requirementFindings.push({
          severity: "error",
          source: "completion",
          message: `Requested capability "${req.label}" is not represented by any executable action in the generated shortcut.`,
          suggestion:
            "This capability may be unsupported in iOS Shortcuts, or the model substituted a Comment. Review the action list.",
        });
      }
    }
  }

  // ── Resolution ────────────────────────────────────────────────────────────
  const allBlockingFindings = [...hollowFindings, ...requirementFindings];

  if (hollowFindings.length > 0) {
    // "unsupported" when all hollow Comments explicitly say so; "incomplete" otherwise
    const allExplicitlyUnsupported = hollowFindings.every((f) =>
      /\b(unsupported|not\s+(supported|available))\b/i.test(f.message),
    );
    return {
      satisfied: false,
      status: allExplicitlyUnsupported ? "unsupported" : "incomplete",
      missingCapabilities,
      unsupportedActions: [],
      hollowActions: hollowActionIdentifiers,
      blockingFindings: allBlockingFindings,
    };
  }

  if (requirementFindings.length > 0) {
    return {
      satisfied: false,
      status: "unsupported",
      missingCapabilities,
      unsupportedActions: [],
      hollowActions: [],
      blockingFindings: requirementFindings,
    };
  }

  return {
    satisfied: true,
    status: "ready",
    missingCapabilities: [],
    unsupportedActions: [],
    hollowActions: [],
    blockingFindings: [],
  };
}
