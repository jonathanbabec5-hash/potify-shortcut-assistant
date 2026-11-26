import { useSyncExternalStore } from 'react';
import type { ShortcutPlist } from '@workspace/api-client-react';

let currentShortcut: ShortcutPlist | null = null;

/**
 * The generation run the current shortcut came from, when it came from one.
 *
 * Feedback and repair collection are matched on this id, so a shortcut the user
 * pasted in themselves correctly carries null and attaches to nothing rather
 * than being grafted onto whichever run happened to be last.
 */
let currentRunId: string | null = null;

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const shortcutStore = {
  /** Starts a new shortcut, and with it a new run association. */
  set(s: ShortcutPlist | null, runId: string | null = null) {
    currentShortcut = s;
    currentRunId = runId;
    emit();
  },
  /**
   * Replaces the shortcut while keeping the run it belongs to — used by the
   * Builder, whose edits are changes *to* a run, not a new one.
   */
  update(s: ShortcutPlist | null) {
    currentShortcut = s;
    emit();
  },
  get() {
    return currentShortcut;
  },
  getRunId() {
    return currentRunId;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useCurrentShortcut() {
  return useSyncExternalStore(shortcutStore.subscribe, shortcutStore.get);
}

export function useActiveRunId() {
  return useSyncExternalStore(shortcutStore.subscribe, shortcutStore.getRunId);
}
