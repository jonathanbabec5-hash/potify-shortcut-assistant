/**
 * Pipeline regression tests — all deterministic (no LLM required for assertions 1–6).
 *
 * Assertion 1: RC-001's regression case checklist has 3 conditions + 2 actions + 1 structure item.
 * Assertion 2: irToShortcut produces exactly 3 is.workflow.actions.conditional openers.
 * Assertion 3: Each If block has a distinct GroupingIdentifier.
 * Assertion 4: No is.workflow.actions.conditional.otherwise (no else-branch needed for "do nothing" case).
 * Assertion 5: HomeKit set-on step appears after the 3rd conditional in the flat plist.
 * Assertion 6: sealChecklist blocks success until all checklist items are satisfied.
 * Assertion 7: A broken description IR returns failure with the missing distance + sunset items.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REGRESSION_CASES } from "./regression";
import {
  irToShortcut,
  sealChecklist,
  validateIR,
  retrieveSchemas,
  verifySlotsApplied,
} from "./pipeline";
import type { WorkflowIR, IntentChecklist, IntentChecklistItem } from "./pipeline-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChecklist(items: IntentChecklistItem[]): IntentChecklist {
  return {
    items,
    hash: "test",
    lockedAt: Date.now(),
  };
}

// ── Synthetic RC-001 IR (no LLM required) ────────────────────────────────────
//
// Represents the expected triple-nested structure for RC-001.
// - s1: getcurrentlocation (preamble)
// - s2: getdistance (preamble)
// - s3: is.workflow.actions.conditional (outer If — distance check)
// - s4: getsunrisesunset (inside outer then-branch, before middle If)
// - s5: is.workflow.actions.conditional (middle If — sunset check)
// - s6: com.apple.homekit.getcharacteristic (inside middle then-branch, before inner If)
// - s7: is.workflow.actions.conditional (inner If — lights-off check)
// - s8: com.apple.homekit.setcharacteristic (turn on — inside inner then-branch)
// - s9: com.apple.homekit.setcharacteristic (warm color — inside inner then-branch)

const RC001_IR: WorkflowIR = {
  goal: "RC-001 test: home/sunset/lights triple-nested",
  steps: [
    {
      id: "s1",
      actionIdentifier: "is.workflow.actions.getcurrentlocation",
      parameterBindings: [],
      justifiedByItemId: "IC-001-proximity",
    },
    {
      id: "s2",
      actionIdentifier: "is.workflow.actions.getdistance",
      parameterBindings: [],
      justifiedByItemId: "IC-001-proximity",
    },
    {
      id: "s3",
      actionIdentifier: "is.workflow.actions.conditional",
      parameterBindings: [
        { key: "WFCondition", valueType: "number", value: 1, source: "literal" },
        { key: "WFNumberValue", valueType: "number", value: 1, source: "literal" },
      ],
      justifiedByItemId: "IC-001-proximity",
    },
    {
      id: "s4",
      actionIdentifier: "is.workflow.actions.getsunrisesunset",
      parameterBindings: [],
      justifiedByItemId: "IC-001-sunset",
    },
    {
      id: "s5",
      actionIdentifier: "is.workflow.actions.conditional",
      parameterBindings: [
        { key: "WFCondition", valueType: "number", value: 8, source: "literal" },
      ],
      justifiedByItemId: "IC-001-sunset",
    },
    {
      id: "s6",
      actionIdentifier: "com.apple.homekit.getcharacteristic",
      parameterBindings: [],
      justifiedByItemId: "IC-001-lights-state",
    },
    {
      id: "s7",
      actionIdentifier: "is.workflow.actions.conditional",
      parameterBindings: [
        { key: "WFCondition", valueType: "string", value: "false", source: "literal" },
      ],
      justifiedByItemId: "IC-001-lights-state",
    },
    {
      id: "s8",
      actionIdentifier: "com.apple.homekit.setcharacteristic",
      parameterBindings: [
        { key: "WFHomekitCharacteristicValue", valueType: "boolean", value: true, source: "literal" },
      ],
      justifiedByItemId: "IC-001-lights-on",
    },
    {
      id: "s9",
      actionIdentifier: "com.apple.homekit.setcharacteristic",
      parameterBindings: [
        { key: "WFHomekitCharacteristicValue", valueType: "number", value: 2700, source: "literal" },
      ],
      justifiedByItemId: "IC-001-warm-color",
    },
  ],
  variables: [],
  controlFlow: [
    {
      type: "if",
      conditionStepId: "s3",
      thenSteps: ["s4", "s5"],
      elseSteps: [],
      nestedBlocks: [
        {
          type: "if",
          conditionStepId: "s5",
          thenSteps: ["s6", "s7"],
          elseSteps: [],
          checklistItemId: "IC-001-sunset",
          nestedBlocks: [
            {
              type: "if",
              conditionStepId: "s7",
              thenSteps: ["s8", "s9"],
              elseSteps: [],
              checklistItemId: "IC-001-lights-state",
              nestedBlocks: [],
            },
          ],
        },
      ],
      checklistItemId: "IC-001-proximity",
    },
  ],
  satisfies: [
    "IC-001-proximity",
    "IC-001-sunset",
    "IC-001-lights-state",
    "IC-001-lights-on",
    "IC-001-warm-color",
  ],
};

// ── Assertion 1: RC-001 checklist structure (from regression.ts) ─────────────

describe("Assertion 1: RC-001 regression case checklist", () => {
  it("has exactly 3 condition items and 2 action items", () => {
    const rc001 = REGRESSION_CASES.find((c) => c.id === "RC-001");
    assert.ok(rc001, "RC-001 must exist in REGRESSION_CASES");

    const conditions = rc001.intentChecklist.filter((i) => i.category === "condition");
    const actions = rc001.intentChecklist.filter((i) => i.category === "action");
    const structures = rc001.intentChecklist.filter((i) => i.category === "structure");

    assert.equal(conditions.length, 3, `Expected 3 condition items, got ${conditions.length}`);
    assert.equal(actions.length, 2, `Expected 2 action items, got ${actions.length}`);
    assert.equal(structures.length, 1, `Expected 1 structure item, got ${structures.length}`);
    assert.equal(
      rc001.intentChecklist.length,
      6,
      `Expected 6 total items (3 conditions + 2 actions + 1 structure), got ${rc001.intentChecklist.length}`,
    );
  });

  it("includes a proximity condition, a sunset condition, and a lights-state condition", () => {
    const rc001 = REGRESSION_CASES.find((c) => c.id === "RC-001")!;
    const ids = rc001.intentChecklist.map((i) => i.id);
    assert.ok(ids.includes("IC-001-proximity"), "Missing IC-001-proximity");
    assert.ok(ids.includes("IC-001-sunset"), "Missing IC-001-sunset");
    assert.ok(ids.includes("IC-001-lights-state"), "Missing IC-001-lights-state");
  });

  it("has expectedControlFlowDepth === 3", () => {
    const rc001 = REGRESSION_CASES.find((c) => c.id === "RC-001")!;
    assert.equal(rc001.expectedControlFlowDepth, 3);
  });
});

// ── Assertions 2–5: irToShortcut structural correctness ─────────────────────

describe("Assertions 2–5: irToShortcut plist structure for RC-001 IR", () => {
  const plist = irToShortcut(RC001_IR, "RC-001 test");
  const actions = plist.WFWorkflowActions;

  it("Assertion 2: produces exactly 3 is.workflow.actions.conditional openers", () => {
    const conditionalOpeners = actions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional",
    );
    assert.equal(
      conditionalOpeners.length,
      3,
      `Expected 3 conditional openers, got ${conditionalOpeners.length}`,
    );
  });

  it("Assertion 3: each If block has a distinct GroupingIdentifier", () => {
    const conditionals = actions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional",
    );
    const groupIds = conditionals.map((a) => a.GroupingIdentifier);
    assert.equal(groupIds.length, 3, "Expected 3 conditional actions");
    const unique = new Set(groupIds);
    assert.equal(unique.size, 3, `GroupingIdentifiers are not all distinct: ${JSON.stringify(groupIds)}`);
    // Also verify End-If actions share the same GroupingIdentifiers
    const endIfs = actions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional.end",
    );
    assert.equal(endIfs.length, 3, "Expected 3 conditional.end actions");
    for (const endIf of endIfs) {
      assert.ok(
        unique.has(endIf.GroupingIdentifier!),
        `End-If GroupingIdentifier "${endIf.GroupingIdentifier}" does not match any opener`,
      );
    }
  });

  it("Assertion 4: no is.workflow.actions.conditional.otherwise (otherwise: do nothing)", () => {
    const otherwise = actions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional.otherwise",
    );
    assert.equal(
      otherwise.length,
      0,
      `Expected 0 Otherwise actions (do-nothing else-branch), got ${otherwise.length}`,
    );
  });

  it("Assertion 5: HomeKit set-on step appears after the 3rd conditional", () => {
    const identifiers = actions.map((a) => a.WFWorkflowActionIdentifier);

    // Find the index of the 3rd conditional opener
    let conditionalCount = 0;
    let thirdConditionalIdx = -1;
    for (let i = 0; i < identifiers.length; i++) {
      if (identifiers[i] === "is.workflow.actions.conditional") {
        conditionalCount++;
        if (conditionalCount === 3) {
          thirdConditionalIdx = i;
          break;
        }
      }
    }
    assert.ok(thirdConditionalIdx >= 0, "Could not find the 3rd conditional");

    // Find the HomeKit set-on action (s8: setcharacteristic with value: true)
    const setOnIdx = actions.findIndex(
      (a) =>
        a.WFWorkflowActionIdentifier.toLowerCase().includes("setcharacteristic") &&
        (a.WFWorkflowActionParameters as any)?.WFHomekitCharacteristicValue === true,
    );
    assert.ok(setOnIdx >= 0, "Could not find the HomeKit set-on action");
    assert.ok(
      setOnIdx > thirdConditionalIdx,
      `Expected set-on (idx ${setOnIdx}) to appear after the 3rd conditional (idx ${thirdConditionalIdx})`,
    );
  });
});

// ── Assertion 6: sealChecklist blocks success until all items satisfied ───────

describe("Assertion 6: sealChecklist satisfaction gate", () => {
  const mockChecklist = makeChecklist([
    {
      id: "IC-test-proximity",
      type: "condition",
      description: "Check distance to home",
      requiredActions: ["is.workflow.actions.getdistance"],
    },
    {
      id: "IC-test-sunset",
      type: "condition",
      description: "Check if after sunset",
      requiredActions: ["is.workflow.actions.getsunrisesunset"],
    },
    {
      id: "IC-test-lights-on",
      type: "action",
      description: "Turn on lights",
      requiredActions: ["homekit.setstate"],
      externalDomain: true,
    },
  ]);

  it("returns satisfied: false when ir.satisfies is empty", () => {
    const irWithNoSatisfied: WorkflowIR = {
      ...RC001_IR,
      satisfies: [],
    };
    const plist = irToShortcut(irWithNoSatisfied);
    const result = sealChecklist(mockChecklist, plist, irWithNoSatisfied);
    assert.equal(result.satisfied, false, "Expected unsatisfied when ir.satisfies is empty");
    assert.ok(result.unsatisfiedItems.length > 0, "Expected non-empty unsatisfiedItems");
  });

  it("returns satisfied: false when a required non-external action is missing from plist", () => {
    const irPartial: WorkflowIR = {
      goal: "partial",
      steps: [
        { id: "s1", actionIdentifier: "is.workflow.actions.getsunrisesunset", parameterBindings: [], justifiedByItemId: "IC-test-sunset" },
      ],
      variables: [],
      controlFlow: [],
      satisfies: ["IC-test-proximity", "IC-test-sunset", "IC-test-lights-on"],
    };
    const plistPartial = irToShortcut(irPartial);
    const result = sealChecklist(mockChecklist, plistPartial, irPartial);
    // IC-test-proximity requires getdistance which is not in plistPartial
    const unsatisfiedIds = result.unsatisfiedItems.map((i) => i.id);
    assert.ok(
      unsatisfiedIds.includes("IC-test-proximity"),
      `Expected IC-test-proximity in unsatisfiedItems, got: ${JSON.stringify(unsatisfiedIds)}`,
    );
  });

  it("returns satisfied: true when all non-constraint items are satisfied", () => {
    const plist = irToShortcut(RC001_IR);
    // Create a checklist that the RC001_IR satisfies
    const fullChecklist = makeChecklist([
      { id: "IC-001-proximity", type: "condition", description: "Distance check", requiredActions: ["is.workflow.actions.getdistance"] },
      { id: "IC-001-sunset", type: "condition", description: "Sunset check", requiredActions: ["is.workflow.actions.getsunrisesunset"] },
      { id: "IC-001-lights-state", type: "condition", description: "Lights state", requiredActions: ["homekit.getstate"], externalDomain: true },
      { id: "IC-001-lights-on", type: "action", description: "Turn on lights", requiredActions: ["homekit.setstate"], externalDomain: true },
      { id: "IC-001-warm-color", type: "action", description: "Set warm color", requiredActions: ["homekit.setstate"], externalDomain: true },
    ]);
    const result = sealChecklist(fullChecklist, plist, RC001_IR);
    assert.equal(
      result.satisfied,
      true,
      `Expected satisfied: true, unsatisfiedItems: ${JSON.stringify(result.unsatisfiedItems.map((i) => i.id))}`,
    );
  });
});

// ── Assertion 7: broken description fails with specific unsatisfied items ─────

describe("Assertion 7: broken description IR returns failure with specific missing items", () => {
  it("IR for 'check if raining then turn on lights' fails with missing proximity + sunset items", () => {
    // This IR represents a shortcut that only checks for rain — not distance or sunset
    const brokenIR: WorkflowIR = {
      goal: "check if raining then turn on lights",
      steps: [
        {
          id: "b1",
          actionIdentifier: "is.workflow.actions.getcurrentweather",
          parameterBindings: [],
          justifiedByItemId: "IC-rain",
        },
        {
          id: "b2",
          actionIdentifier: "is.workflow.actions.conditional",
          parameterBindings: [{ key: "WFCondition", valueType: "string", value: "isRaining", source: "literal" }],
          justifiedByItemId: "IC-rain",
        },
        {
          id: "b3",
          actionIdentifier: "com.apple.homekit.setcharacteristic",
          parameterBindings: [],
          justifiedByItemId: "IC-lights-on",
        },
      ],
      variables: [],
      controlFlow: [
        {
          type: "if",
          conditionStepId: "b2",
          thenSteps: ["b3"],
          elseSteps: [],
          nestedBlocks: [],
        },
      ],
      // Broken: only satisfies rain + lights-on — NOT proximity or sunset
      satisfies: ["IC-rain", "IC-lights-on"],
    };

    // The checklist includes the distance and sunset requirements from RC-001
    const rc001Checklist = makeChecklist([
      { id: "IC-001-proximity", type: "condition", description: "Distance check", requiredActions: ["is.workflow.actions.getdistance"] },
      { id: "IC-001-sunset", type: "condition", description: "Sunset check", requiredActions: ["is.workflow.actions.getsunrisesunset"] },
      { id: "IC-001-lights-state", type: "condition", description: "Lights state check", requiredActions: ["homekit.getstate"], externalDomain: true },
      { id: "IC-001-lights-on", type: "action", description: "Turn on lights", requiredActions: ["homekit.setstate"], externalDomain: true },
      { id: "IC-001-warm-color", type: "action", description: "Set warm color", requiredActions: ["homekit.setstate"], externalDomain: true },
    ]);

    const brokenPlist = irToShortcut(brokenIR);
    const result = sealChecklist(rc001Checklist, brokenPlist, brokenIR);

    assert.equal(
      result.satisfied,
      false,
      "Expected sealChecklist to return satisfied: false for the broken description",
    );

    const unsatisfiedIds = result.unsatisfiedItems.map((i) => i.id);

    assert.ok(
      unsatisfiedIds.includes("IC-001-proximity"),
      `Expected IC-001-proximity in unsatisfiedItems (missing distance check). Got: ${JSON.stringify(unsatisfiedIds)}`,
    );

    assert.ok(
      unsatisfiedIds.includes("IC-001-sunset"),
      `Expected IC-001-sunset in unsatisfiedItems (missing sunset check). Got: ${JSON.stringify(unsatisfiedIds)}`,
    );
  });

  it("validateIR flags missing checklist items as non-advisory errors", () => {
    const brokenIR: WorkflowIR = {
      goal: "rain lights",
      steps: [
        { id: "b1", actionIdentifier: "is.workflow.actions.getcurrentweather", parameterBindings: [], justifiedByItemId: "IC-rain" },
      ],
      variables: [],
      controlFlow: [],
      satisfies: [], // nothing satisfied
    };

    const partialChecklist = makeChecklist([
      { id: "IC-001-proximity", type: "condition", description: "Distance check", requiredActions: ["is.workflow.actions.getdistance"] },
      { id: "IC-rain", type: "condition", description: "Rain check", requiredActions: ["is.workflow.actions.getcurrentweather"] },
    ]);

    const { schemas } = retrieveSchemas(partialChecklist);
    const errors = validateIR(brokenIR, partialChecklist, schemas);
    const checklistErrors = errors.filter((e) => e.stage === "checklist" && !e.advisory);

    assert.ok(
      checklistErrors.some((e) => e.checklistItemId === "IC-001-proximity"),
      `Expected a hard checklist error for IC-001-proximity. Errors: ${JSON.stringify(checklistErrors)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confirmed user answers must reach the generated shortcut
//
// runPipeline previously declared its slots parameter as `_slots` and never read
// it, so every answer the user typed into the clarification dialog was discarded
// server-side. verifySlotsApplied is the deterministic backstop: prompt wording
// alone cannot guarantee the model uses a supplied value.
// ─────────────────────────────────────────────────────────────────────────────

describe("verifySlotsApplied", () => {
  const plistWith = (actions: Array<{ id: string; params?: Record<string, unknown> }>) => ({
    WFWorkflowClientVersion: "2702",
    WFWorkflowMinimumClientVersion: 1500,
    WFWorkflowName: "test",
    WFWorkflowActions: actions.map((a) => ({
      WFWorkflowActionIdentifier: a.id,
      WFWorkflowActionParameters: a.params ?? {},
    })),
  });

  it("reports nothing when no slots were supplied", () => {
    const plist = plistWith([{ id: "is.workflow.actions.getcurrentweather" }]);
    assert.deepEqual(verifySlotsApplied(plist, {}), []);
  });

  it("passes when a supplied recipient appears in the plist", () => {
    const plist = plistWith([
      {
        id: "is.workflow.actions.sendmessage",
        params: { WFSendMessageActionRecipients: ["Jane Doe"] },
      },
    ]);
    assert.deepEqual(verifySlotsApplied(plist, { recipient: "Jane Doe" }), []);
  });

  it("reports a supplied recipient that was dropped", () => {
    const plist = plistWith([
      {
        id: "is.workflow.actions.sendmessage",
        params: { WFSendMessageActionRecipients: ["Contact"] },
      },
    ]);
    const unapplied = verifySlotsApplied(plist, { recipient: "Jane Doe" });
    assert.equal(unapplied.length, 1);
    assert.equal(unapplied[0].key, "recipient");
    assert.equal(unapplied[0].value, "Jane Doe");
  });

  it("accepts a condition that was serialised into a structured action", () => {
    // "battery below 20%" legitimately becomes a getbatterylevel action plus a
    // numeric threshold, so an exact-phrase check would reject correct output.
    const plist = plistWith([
      { id: "is.workflow.actions.getbatterylevel" },
      { id: "is.workflow.actions.conditional", params: { WFCondition: 2, WFNumberValue: 20 } },
    ]);
    assert.deepEqual(verifySlotsApplied(plist, { condition: "battery below 20%" }), []);
  });

  it("reports a condition the shortcut never checks", () => {
    const plist = plistWith([
      { id: "is.workflow.actions.getcurrentweather" },
      { id: "is.workflow.actions.conditional", params: { WFCondition: 2 } },
    ]);
    const unapplied = verifySlotsApplied(plist, { condition: "headphones connected" });
    assert.equal(unapplied.length, 1);
    assert.equal(unapplied[0].key, "condition");
  });

  it("skips values with nothing substantial to match on", () => {
    const plist = plistWith([{ id: "is.workflow.actions.getcurrentweather" }]);
    // "on" has no token of three or more characters — unverifiable either way,
    // so it must not be reported as a failure.
    assert.deepEqual(verifySlotsApplied(plist, { state: "on" }), []);
  });

  it("ignores blank answers", () => {
    const plist = plistWith([{ id: "is.workflow.actions.getcurrentweather" }]);
    assert.deepEqual(verifySlotsApplied(plist, { recipient: "   ", messageBody: "" }), []);
  });

  it("does not pass a dropped answer on a coincidental substring", () => {
    // Plain substring matching over the whole plist let "Ann" pass against an
    // unrelated "Banner", which is a false pass on the one guarantee this
    // function provides. Parameter values must match whole words.
    const plist = plistWith([
      {
        id: "is.workflow.actions.notification",
        params: { WFNotificationActionTitle: "Banner text", WFInput: "planner output" },
      },
    ]);
    const unapplied = verifySlotsApplied(plist, { recipient: "Ann" });
    assert.equal(unapplied.length, 1);
    assert.equal(unapplied[0].key, "recipient");
  });

  it("still matches a whole word inside a longer parameter value", () => {
    const plist = plistWith([
      {
        id: "is.workflow.actions.sendmessage",
        params: { WFSendMessageActionText: "I am home now, see you soon" },
      },
    ]);
    assert.deepEqual(verifySlotsApplied(plist, { messageBody: "I am home now" }), []);
  });
});
