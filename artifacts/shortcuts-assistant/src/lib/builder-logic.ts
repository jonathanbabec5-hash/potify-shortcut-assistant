import type { ShortcutAction, ShortcutPlist } from '@workspace/api-client-react';

export function addActionToShortcut(
  shortcut: ShortcutPlist,
  identifier: string,
  parameters: Record<string, unknown> = {},
): ShortcutPlist {
  const currentActions = shortcut.WFWorkflowActions || [];
  const newAction: ShortcutAction = {
    WFWorkflowActionIdentifier: identifier,
    WFWorkflowActionParameters: parameters,
  };
  return {
    ...shortcut,
    WFWorkflowActions: [...currentActions, newAction],
  };
}

export function addSuggestedActionToShortcut(
  shortcut: ShortcutPlist,
  suggestion: { identifier: string; parameters?: Record<string, unknown> },
): ShortcutPlist {
  return addActionToShortcut(
    shortcut,
    suggestion.identifier,
    suggestion.parameters || {},
  );
}

export function moveActionInShortcut(
  shortcut: ShortcutPlist,
  index: number,
  direction: 'up' | 'down',
): ShortcutPlist {
  const currentActions = shortcut.WFWorkflowActions || [];
  if (direction === 'up' && index === 0) return shortcut;
  if (direction === 'down' && index === currentActions.length - 1) return shortcut;

  const newActions = [...currentActions];
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  [newActions[index], newActions[targetIndex]] = [newActions[targetIndex], newActions[index]];
  return { ...shortcut, WFWorkflowActions: newActions };
}

export function deleteActionFromShortcut(
  shortcut: ShortcutPlist,
  index: number,
): ShortcutPlist {
  const currentActions = shortcut.WFWorkflowActions || [];
  const newActions = [...currentActions];
  newActions.splice(index, 1);
  return { ...shortcut, WFWorkflowActions: newActions };
}

export function isValidActionIdentifier(identifier: string): boolean {
  return typeof identifier === 'string' && identifier.length > 0 && identifier.includes('.');
}
