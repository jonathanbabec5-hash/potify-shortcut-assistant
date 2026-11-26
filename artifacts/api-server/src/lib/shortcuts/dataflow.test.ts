/**
 * Regression tests for findUnreachableSteps (via analyzeDataFlow).
 *
 * These tests guard against the false-positive bug where valid If / Otherwise / End If
 * blocks were incorrectly marked as having unreachable steps because the Otherwise
 * action shares its GroupingIdentifier with the parent If and End If actions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDataFlow } from './dataflow';
import type { ShortcutPlist } from './catalog';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal action with no parameters. */
function action(identifier: string, groupId?: string) {
  return {
    WFWorkflowActionIdentifier: identifier,
    WFWorkflowActionParameters: {},
    ...(groupId ? { GroupingIdentifier: groupId } : {}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('If / End If (no Otherwise) → zero unreachable steps', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional',     'g1'),
      action('is.workflow.actions.showresult'),          // if-branch body
      action('is.workflow.actions.conditional.end', 'g1'),
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.deepEqual(result.unreachableSteps, [],
    'A properly closed If / End If should have no unreachable steps');
});

test('If / Otherwise / End If → zero unreachable steps (the core regression)', () => {
  // This is the scenario that previously produced false-positive unreachable
  // findings: Otherwise shares GroupingIdentifier with If and End If.
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional',           'g1'),
      action('is.workflow.actions.showresult'),                 // if-branch body
      action('is.workflow.actions.conditional.otherwise', 'g1'), // same UUID — intentional
      action('is.workflow.actions.showresult'),                 // else-branch body
      action('is.workflow.actions.conditional.end',       'g1'), // same UUID — intentional
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.deepEqual(result.unreachableSteps, [],
    'Otherwise and else-branch actions must not be flagged as unreachable');
});

test('If without End If → step after opener is unreachable', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional', 'g2'),   // index 0 — opener, never closed
      action('is.workflow.actions.showresult'),           // index 1 — should be flagged
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.ok(
    result.unreachableSteps.includes(1),
    `Expected step 1 to be unreachable for unclosed If, got: ${JSON.stringify(result.unreachableSteps)}`,
  );
});

test('Nested Repeat inside a closed If → zero unreachable steps', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional',       'g3'),
      action('is.workflow.actions.repeat.count',      'g4'),
      action('is.workflow.actions.showresult'),
      action('is.workflow.actions.repeat.count.end',  'g4'),
      action('is.workflow.actions.conditional.end',   'g3'),
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.deepEqual(result.unreachableSteps, [],
    'Properly nested closed groups should produce no unreachable steps');
});

test('Multiple independent If blocks → zero unreachable steps', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional',           'g5'),
      action('is.workflow.actions.showresult'),
      action('is.workflow.actions.conditional.end',       'g5'),
      action('is.workflow.actions.conditional',           'g6'),
      action('is.workflow.actions.conditional.otherwise', 'g6'),
      action('is.workflow.actions.showresult'),
      action('is.workflow.actions.conditional.end',       'g6'),
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.deepEqual(result.unreachableSteps, [],
    'Two independent properly-formed If blocks should have no unreachable steps');
});

test('Unclosed If followed by closed Repeat → only If body is unreachable', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional',      'g7'),  // index 0 — unclosed
      action('is.workflow.actions.showresult'),               // index 1 — unreachable
      action('is.workflow.actions.repeat.count',     'g8'),  // index 2 — closed below
      action('is.workflow.actions.showresult'),               // index 3 — reachable (inside closed repeat)
      action('is.workflow.actions.repeat.count.end', 'g8'),  // index 4
    ],
  };
  const result = analyzeDataFlow(shortcut);
  assert.ok(
    result.unreachableSteps.includes(1),
    `Expected step 1 unreachable for unclosed If, got: ${JSON.stringify(result.unreachableSteps)}`,
  );
  assert.ok(
    !result.unreachableSteps.includes(3),
    `Step 3 inside closed Repeat must NOT be unreachable, got: ${JSON.stringify(result.unreachableSteps)}`,
  );
});

test('Empty shortcut → zero unreachable steps', () => {
  const shortcut: ShortcutPlist = { WFWorkflowActions: [] };
  const result = analyzeDataFlow(shortcut);
  assert.deepEqual(result.unreachableSteps, []);
});
