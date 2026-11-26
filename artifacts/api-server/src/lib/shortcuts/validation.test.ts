/**
 * Regression tests for validateShortcut — specifically for the hardSchemaErrors
 * taxonomy used by the 422 gate in the generate route.
 *
 * Tests confirm:
 *   - Unknown action identifiers → warning only, NOT a hard error (422 must not fire)
 *   - Missing required parameter → hard error (422 must fire)
 *   - Valid If / Otherwise / End If → no hard errors (the core false-positive regression)
 *   - Unclosed If block → severity "error" in findings but NOT a hard error (advisory only)
 *   - Empty shortcut → hard error
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateShortcut } from './validation';
import type { ShortcutPlist } from './catalog';

// ─── helpers ─────────────────────────────────────────────────────────────────

function action(identifier: string, params: Record<string, unknown> = {}, groupId?: string) {
  return {
    WFWorkflowActionIdentifier: identifier,
    WFWorkflowActionParameters: params,
    ...(groupId ? { GroupingIdentifier: groupId } : {}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('valid If / Otherwise / End If → zero hard errors and zero schema errors', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      // Get Distance produces a numeric value; If compares it
      action('is.workflow.actions.getdistance', { WFGetDistanceActionInput: 'Apple Park' }),
      action('is.workflow.actions.conditional', { WFCondition: 4, WFNumberValue: 30 }, 'g1'),
      action('is.workflow.actions.showresult',  { WFTextActionText: 'Far' }),
      action('is.workflow.actions.conditional.otherwise', {}, 'g1'),
      action('is.workflow.actions.showresult',  { WFTextActionText: 'Close' }),
      action('is.workflow.actions.conditional.end', {}, 'g1'),
    ],
  };
  const result = validateShortcut(shortcut);
  assert.deepEqual(result.hardSchemaErrors, [],
    'Well-formed If/Otherwise/End If must not produce hard errors');
  const schemaErrors = result.findings.filter(f => f.source === 'schema' && f.severity === 'error');
  assert.deepEqual(schemaErrors, [],
    'Well-formed If/Otherwise/End If must not produce schema errors');
});

test('missing required parameter → hard error that fires the 422 gate', () => {
  // is.workflow.actions.getdistance requires WFGetDistanceActionInput.
  // Omitting it produces a hard missing-required-parameter error.
  // (We use getdistance rather than conditional because the controlFlowActions
  //  override for conditional strips its required params for grouping reasons.)
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.getdistance', {}), // WFGetDistanceActionInput is required but missing
    ],
  };
  const result = validateShortcut(shortcut);
  assert.ok(
    result.hardSchemaErrors.length > 0,
    `Expected at least one hard error for missing required param, got: ${JSON.stringify(result.hardSchemaErrors)}`,
  );
  assert.ok(
    result.hardSchemaErrors.every(f => f.source === 'schema' && f.severity === 'error'),
    'All hard errors must be source=schema, severity=error',
  );
  assert.ok(
    result.hardSchemaErrors.some(f => f.message.includes('missing required parameter')),
    'Hard error must mention missing required parameter',
  );
});

test('unknown action identifier → advisory warning only, NOT a hard error', () => {
  // Simulates an action the catalog doesn't know (e.g. a newer iOS action or third-party)
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.thisActionDoesNotExistInCatalog'),
    ],
  };
  const result = validateShortcut(shortcut);
  assert.deepEqual(result.hardSchemaErrors, [],
    'Unknown identifier must not be a hard error — 422 must not fire');
  const warnings = result.findings.filter(
    f => f.severity === 'warning' && f.message.includes('not in the known catalog'),
  );
  assert.ok(warnings.length > 0, 'Unknown identifier should produce an advisory warning');
});

test('unclosed If block → error in findings, but NOT a hard error (advisory only)', () => {
  // An If without End If is a genuine structural problem, but it's a control-flow
  // heuristic — not a definitively blocking hard error for the 422 gate.
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.conditional', { WFCondition: 4 }, 'g3'),
      action('is.workflow.actions.showresult', { WFTextActionText: 'yes' }),
      // No End If
    ],
  };
  const result = validateShortcut(shortcut);
  assert.deepEqual(result.hardSchemaErrors, [],
    'Unclosed If must not be a hard error — let the LLM output through with advisory findings');
  // The structural error IS surfaced as a finding — just not as a 422-blocking hard error.
  const controlFlowErrors = result.findings.filter(
    f => f.severity === 'error' && f.source === 'schema' && f.message.includes('no matching End'),
  );
  assert.ok(controlFlowErrors.length > 0, 'Unclosed If should still produce a schema error finding');
});

test('empty shortcut → hard error', () => {
  const shortcut: ShortcutPlist = { WFWorkflowActions: [] };
  const result = validateShortcut(shortcut);
  assert.ok(result.hardSchemaErrors.length > 0,
    'Empty shortcut must be a hard error');
  assert.ok(result.hardSchemaErrors[0].message.includes('no actions'),
    'Hard error message should mention "no actions"');
});

test('action with missing WFWorkflowActionIdentifier → hard error', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: '', WFWorkflowActionParameters: {} },
    ],
  };
  const result = validateShortcut(shortcut);
  assert.ok(result.hardSchemaErrors.length > 0,
    'Missing identifier must be a hard error');
});

test('fully valid shortcut with known action and required param → no hard errors', () => {
  const shortcut: ShortcutPlist = {
    WFWorkflowActions: [
      action('is.workflow.actions.showresult', { WFTextActionText: 'Hello' }),
    ],
  };
  const result = validateShortcut(shortcut);
  assert.deepEqual(result.hardSchemaErrors, []);
});
