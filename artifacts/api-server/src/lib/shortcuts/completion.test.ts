/**
 * Regression tests for checkCompletion.
 *
 * The canonical regression scenario is:
 *   "check if within 1 km of home, after sunset, living room lights off,
 *    then turn on lights and set warm color; otherwise do nothing"
 *
 * This requires getdistance + getsunrisesunset + HomeKit actions.
 * When the model cannot produce HomeKit actions it substitutes Comments.
 * The completion gate must catch that substitution and return satisfied:false.
 *
 * Tests never modify prompts, catalogs, validators, or weights.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompletion } from "./completion";
import type { ShortcutPlist } from "./catalog";
import type { ValidationResult } from "./validation";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeValidation(hardErrors: boolean = false): ValidationResult {
  const hardSchemaErrors = hardErrors
    ? [
        {
          severity: "error" as const,
          source: "schema" as const,
          message: "Shortcut has no actions. Add at least one action to make it useful.",
        },
      ]
    : [];
  return {
    findings: hardSchemaErrors,
    hardSchemaErrors,
    minimumClientVersion: 700,
    minimumIosVersion: "12.0",
    requiredPermissions: [],
    requiredDeviceFeatures: [],
    dataFlowSummary: {
      producedVariables: 0,
      consumedVariables: 0,
      unboundInputs: 0,
      unreachableSteps: [],
    },
    executionTrace: [],
  };
}

function action(
  identifier: string,
  params: Record<string, unknown> = {},
  groupId?: string,
): ShortcutPlist["WFWorkflowActions"][number] {
  return {
    WFWorkflowActionIdentifier: identifier,
    WFWorkflowActionParameters: params,
    ...(groupId ? { GroupingIdentifier: groupId } : {}),
  };
}

function commentAction(text: string) {
  return action("is.workflow.actions.comment", { WFCommentActionText: text });
}

// ─── Canonical regression: home / distance / sunset / lights ─────────────────

const REGRESSION_DESCRIPTION =
  "check if within 1 km of home, after sunset, living room lights off, " +
  "then turn on lights and set warm color; otherwise do nothing";

test("regression: Comment-only placeholder for HomeKit → incomplete, satisfied:false", () => {
  // This is the exact failure mode: the model cannot implement HomeKit control
  // and substitutes a Comment. The gate must catch it.
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.getdistance", {
        WFGetDistanceActionInput: "Home",
      }),
      action("is.workflow.actions.conditional", {}, "g1"),
      action("is.workflow.actions.getsunrisesunset", {}),
      action("is.workflow.actions.conditional", {}, "g2"),
      commentAction(
        "HomeKit is unsupported in iOS Shortcuts — cannot read or set light state",
      ),
      action("is.workflow.actions.conditional.end", {}, "g2"),
      action("is.workflow.actions.conditional.end", {}, "g1"),
    ],
  };

  const result = checkCompletion(
    REGRESSION_DESCRIPTION,
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false, "must not be satisfied");
  assert.ok(
    result.status === "incomplete" || result.status === "unsupported",
    `expected incomplete or unsupported, got ${result.status}`,
  );
  assert.ok(result.hollowActions.length > 0, "hollowActions must be non-empty");
  assert.ok(
    result.blockingFindings.length > 0,
    "blockingFindings must be non-empty",
  );
  assert.ok(
    result.blockingFindings.every((f) => f.source === "completion"),
    "all blocking findings must have source='completion'",
  );
});

test("regression: purely Comment-only shortcut (all Comments) → incomplete, satisfied:false", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      commentAction("HomeKit is unsupported"),
      commentAction("getsunrisesunset is not available on this iOS version"),
      commentAction("getdistance cannot be used without permissions"),
    ],
  };

  const result = checkCompletion(
    REGRESSION_DESCRIPTION,
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false);
  assert.ok(
    result.status === "incomplete" || result.status === "unsupported",
  );
  assert.ok(result.hollowActions.length > 0);
});

test("regression: shortcut using getsunrisesunset + getdistance + homekit action → satisfied:true", () => {
  // Simulates a correctly-generated shortcut with real HomeKit action identifiers.
  // The homekit identifier pattern is tested here even if the catalog doesn't list it,
  // because the completion gate uses pattern-matching, not catalog lookup.
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.getdistance", {
        WFGetDistanceActionInput: "Home",
      }),
      action("is.workflow.actions.conditional", {}, "g1"),
      action("is.workflow.actions.getsunrisesunset", {}),
      action("is.workflow.actions.conditional", {}, "g2"),
      // A real HomeKit-style action identifier satisfies the homekit pattern
      action("is.workflow.actions.homekit.setcharacteristic", {}),
      action("is.workflow.actions.conditional.end", {}, "g2"),
      action("is.workflow.actions.conditional.otherwise", {}, "g1"),
      action("is.workflow.actions.conditional.end", {}, "g1"),
    ],
  };

  const result = checkCompletion(
    REGRESSION_DESCRIPTION,
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, true, `expected satisfied, got status=${result.status} findings=${JSON.stringify(result.blockingFindings)}`);
  assert.strictEqual(result.status, "ready");
  assert.deepEqual(result.hollowActions, []);
  assert.deepEqual(result.blockingFindings, []);
});

// ─── Core gate tests ──────────────────────────────────────────────────────────

test("hard schema error → validation-failed, satisfied:false", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [],
  };

  const result = checkCompletion(
    "show hello world",
    shortcut,
    makeValidation(true), // pass validation with hard errors
  );

  assert.strictEqual(result.satisfied, false);
  assert.strictEqual(result.status, "validation-failed");
  assert.ok(result.blockingFindings.length > 0);
});

test("valid showresult-only shortcut with simple description → ready, satisfied:true", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.showresult", { WFTextActionText: "Hello!" }),
    ],
  };

  const result = checkCompletion(
    "show a hello world message",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, true);
  assert.strictEqual(result.status, "ready");
  assert.deepEqual(result.hollowActions, []);
});

test("comment saturation (>50% Comments, none hollow) → incomplete, satisfied:false", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.showresult", { WFTextActionText: "Start" }),
      // None of these match HOLLOW_PATTERN, but there are more comments than real actions
      action("is.workflow.actions.comment", { WFCommentActionText: "Step 1" }),
      action("is.workflow.actions.comment", { WFCommentActionText: "Step 2" }),
      action("is.workflow.actions.comment", { WFCommentActionText: "Step 3" }),
    ],
  };

  const result = checkCompletion(
    "do something",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false);
  assert.strictEqual(result.status, "incomplete");
  assert.ok(result.blockingFindings.length > 0);
});

test("single Comment with benign text ('Step 1') → incomplete, satisfied:false", () => {
  // Exact bypass the reviewer caught: a single Comment whose text doesn't
  // match HOLLOW_PATTERN, with a simple description that has no registered
  // capability keywords. Previously returned satisfied:true / status:'ready'.
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      commentAction("Step 1"),
    ],
  };

  const result = checkCompletion(
    "show a hello world message",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false, "single benign Comment must not be satisfied");
  assert.strictEqual(result.status, "incomplete");
  assert.ok(result.hollowActions.length > 0, "hollowActions must be non-empty");
  assert.ok(result.blockingFindings.length > 0, "blockingFindings must be non-empty");
  assert.ok(
    result.blockingFindings.every((f) => f.source === "completion"),
    "all blocking findings must have source='completion'",
  );
});

test("multiple benign Comments with no hollow text → incomplete, satisfied:false", () => {
  // All-Comment shortcut where none of the texts match HOLLOW_PATTERN.
  // Previously only caught if total > 1 *and* saturation fired (>=50%).
  // With all-Comment = 100% >= 50%, saturation would fire — but let's
  // confirm the zero-executable-actions gate fires first (cleaner path).
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      commentAction("Step 1"),
      commentAction("Step 2"),
      commentAction("Step 3"),
    ],
  };

  const result = checkCompletion(
    "do something",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false);
  assert.strictEqual(result.status, "incomplete");
  assert.ok(result.blockingFindings.length > 0);
});

test("hollow comment 'not available' → incomplete, satisfied:false", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      commentAction("This capability is not available in iOS Shortcuts"),
    ],
  };

  const result = checkCompletion(
    "turn on living room lights",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false);
  assert.ok(result.hollowActions.length > 0, "hollowActions must be non-empty");
  assert.ok(result.blockingFindings.length > 0, "blockingFindings must be non-empty");
  // Gate 0b (zero-executable-actions) fires before Gate 1 for single-action
  // shortcuts, so the finding message describes "no executable steps" rather
  // than "Comment action was substituted" — both are correct outcomes.
  assert.ok(
    result.blockingFindings.every((f) => f.source === "completion"),
    "all blocking findings must have source='completion'",
  );
});

test("description mentions capability matched by real action → ready", () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.getdistance", {
        WFGetDistanceActionInput: "Apple Park",
      }),
      action("is.workflow.actions.showresult", { WFTextActionText: "Distance" }),
    ],
  };

  const result = checkCompletion(
    "get the distance to Apple Park",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, true);
  assert.strictEqual(result.status, "ready");
});

test("description mentions capability with NO matching real action → unsupported", () => {
  // Description asks for NFC but shortcut doesn't use any NFC action
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action("is.workflow.actions.showresult", { WFTextActionText: "Scanned" }),
    ],
  };

  const result = checkCompletion(
    "scan an NFC tag and show the result",
    shortcut,
    makeValidation(false),
  );

  assert.strictEqual(result.satisfied, false);
  assert.strictEqual(result.status, "unsupported");
  assert.ok(result.missingCapabilities.includes("NFC tag"));
});
