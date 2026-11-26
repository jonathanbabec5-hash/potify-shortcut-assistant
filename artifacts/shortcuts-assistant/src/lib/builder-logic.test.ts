import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addActionToShortcut,
  addSuggestedActionToShortcut,
  moveActionInShortcut,
  deleteActionFromShortcut,
  isValidActionIdentifier,
} from './builder-logic';

test('addActionToShortcut appends a new action to the end', () => {
  const shortcut = { WFWorkflowActions: [] };
  const result = addActionToShortcut(shortcut, 'is.workflow.actions.sendmessage');
  assert.equal(result.WFWorkflowActions.length, 1);
  assert.equal(result.WFWorkflowActions[0].WFWorkflowActionIdentifier, 'is.workflow.actions.sendmessage');
  assert.deepEqual(result.WFWorkflowActions[0].WFWorkflowActionParameters, {});
});

test('addActionToShortcut preserves existing actions and order', () => {
  const shortcut = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: 'a', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'b', WFWorkflowActionParameters: {} },
    ],
  };
  const result = addActionToShortcut(shortcut, 'c');
  assert.equal(result.WFWorkflowActions.length, 3);
  assert.equal(result.WFWorkflowActions[0].WFWorkflowActionIdentifier, 'a');
  assert.equal(result.WFWorkflowActions[1].WFWorkflowActionIdentifier, 'b');
  assert.equal(result.WFWorkflowActions[2].WFWorkflowActionIdentifier, 'c');
});

test('addActionToShortcut adds parameters when provided', () => {
  const shortcut = { WFWorkflowActions: [] };
  const result = addActionToShortcut(shortcut, 'x', { key: 'value' });
  assert.deepEqual(result.WFWorkflowActions[0].WFWorkflowActionParameters, { key: 'value' });
});

test('addSuggestedActionToShortcut adds a suggestion with parameters', () => {
  const shortcut = { WFWorkflowActions: [] };
  const result = addSuggestedActionToShortcut(shortcut, {
    identifier: 'is.workflow.actions.sendmessage',
    parameters: { body: 'hello' },
  });
  assert.equal(result.WFWorkflowActions.length, 1);
  assert.equal(result.WFWorkflowActions[0].WFWorkflowActionParameters.body, 'hello');
});

test('moveActionInShortcut swaps with the previous action', () => {
  const shortcut = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: 'a', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'b', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'c', WFWorkflowActionParameters: {} },
    ],
  };
  const result = moveActionInShortcut(shortcut, 1, 'up');
  assert.deepEqual(result.WFWorkflowActions.map(a => a.WFWorkflowActionIdentifier), ['b', 'a', 'c']);
});

test('moveActionInShortcut swaps with the next action', () => {
  const shortcut = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: 'a', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'b', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'c', WFWorkflowActionParameters: {} },
    ],
  };
  const result = moveActionInShortcut(shortcut, 1, 'down');
  assert.deepEqual(result.WFWorkflowActions.map(a => a.WFWorkflowActionIdentifier), ['a', 'c', 'b']);
});

test('moveActionInShortcut does nothing at boundaries', () => {
  const shortcut = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: 'a', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'b', WFWorkflowActionParameters: {} },
    ],
  };
  assert.equal(moveActionInShortcut(shortcut, 0, 'up'), shortcut);
  assert.equal(moveActionInShortcut(shortcut, 1, 'down'), shortcut);
});

test('deleteActionFromShortcut removes the action at the index', () => {
  const shortcut = {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: 'a', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'b', WFWorkflowActionParameters: {} },
      { WFWorkflowActionIdentifier: 'c', WFWorkflowActionParameters: {} },
    ],
  };
  const result = deleteActionFromShortcut(shortcut, 1);
  assert.deepEqual(result.WFWorkflowActions.map(a => a.WFWorkflowActionIdentifier), ['a', 'c']);
});

test('isValidActionIdentifier rejects invalid values', () => {
  assert.equal(isValidActionIdentifier('is.workflow.actions.sendmessage'), true);
  assert.equal(isValidActionIdentifier(''), false);
  assert.equal(isValidActionIdentifier('no-dots'), false);
  assert.equal(isValidActionIdentifier('   '), false);
  assert.equal(isValidActionIdentifier(123 as unknown as string), false);
});
