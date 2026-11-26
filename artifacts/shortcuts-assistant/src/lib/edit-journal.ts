/**
 * A record of the structural edits the user made to a generated shortcut.
 *
 * Held in memory only, and deliberately value-free: an edit is recorded as the
 * operation, the position, the action identifier, and — for a parameter change
 * — the *key* that changed. What the user actually typed never enters the
 * journal, so it can never be transmitted no matter what the caller does with
 * the drained events.
 *
 * The journal is drained on submission so an edit is reported once, and cleared
 * whenever a new generation starts so edits can never be attributed to a run
 * they did not belong to.
 */

import type { UserEditEvent } from '@workspace/api-client-react';

let events: UserEditEvent[] = [];

export function recordEdit(event: UserEditEvent): void {
  events.push(event);
}

export function clearEdits(): void {
  events = [];
}

/** Returns the pending edits and empties the journal. */
export function drainEdits(): UserEditEvent[] {
  const drained = events;
  events = [];
  return drained;
}

export function pendingEditCount(): number {
  return events.length;
}
