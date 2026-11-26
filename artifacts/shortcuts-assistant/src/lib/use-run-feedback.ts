/**
 * Reports what happened to a generated shortcut after it left the app.
 *
 * Whether an import actually happened, and whether the shortcut then *ran*, are
 * the only signals that can tell "the pipeline said it was ready" apart from
 * "it was". Nothing else the app records can substitute for them.
 *
 * They are still the user's data. The server refuses them without a matching
 * consent grant, and this hook additionally declines to *ask* when nothing may
 * be kept — a question whose answer is discarded is theatre, and it would train
 * people to ignore the one prompt that matters.
 */

import { useCallback } from 'react';
import {
  useGetConsent,
  useSubmitShortcutFeedback,
} from '@workspace/api-client-react';
import { drainEdits } from '@/lib/edit-journal';
import { shortcutStore, useActiveRunId } from '@/lib/store';
import { getSubjectId } from '@/lib/subject';

export interface RunSignal {
  importConfirmed?: boolean;
  deviceRunSucceeded?: boolean;
  accepted?: boolean;
}

export function useRunFeedback() {
  const subject = getSubjectId();
  const runId = useActiveRunId();
  const consent = useGetConsent({ subject });
  const submit = useSubmitShortcutFeedback();

  const collecting = (consent.data?.scope ?? 'none') !== 'none';
  const canReport = Boolean(runId) && collecting;

  const report = useCallback(
    (signal: RunSignal) => {
      // Both conditions are also enforced server-side. Checking here as well
      // avoids sending data that would only be thrown away, and keeps the
      // journal undrained so nothing is silently lost.
      if (!runId || !collecting) return;

      const edits = drainEdits();
      const accepted = signal.accepted ? shortcutStore.get() : null;

      submit.mutate({
        data: {
          subject,
          runId,
          ...signal,
          ...(edits.length > 0 ? { edits } : {}),
          // Sent only on acceptance, and only so the server can derive a hash
          // of what the user settled on. The plist itself is not stored.
          ...(accepted ? { acceptedShortcut: accepted } : {}),
        },
      });
    },
    [runId, collecting, subject], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { canReport, collecting, runId, report };
}
