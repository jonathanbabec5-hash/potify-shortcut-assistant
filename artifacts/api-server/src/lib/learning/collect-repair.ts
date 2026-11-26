/**
 * The bridge between a finished repair and the collection write path.
 *
 * Repairs are governed exactly like generations, and for the same reason: a
 * repair transcript is derived from the user's own shortcut, so it is their
 * data and it is retained only on their explicit permission. This module adds
 * no new authority — it reuses the same permit issuer, the same scope
 * assertions, and the same total/never-throws contract as `collect-run`.
 *
 * Two tiers, authorised separately:
 *
 *  - The **outcome** is text-free measurement and needs only `outcomes-only`.
 *    Both successful and failed repairs are measured, because a repair engine
 *    that quietly stops fixing things is only visible in the failures.
 *
 *  - The **transcript** is a correction, so it sits at `full-examples`, the
 *    same bar `attachFeedback` already enforces for user edits. Anything less
 *    and the repair is dropped rather than downgraded.
 */

import { withCollectionDeadline } from "./collect-run";
import {
  attachFeedback,
  recordOutcome,
  tryAuthorizeCollection,
} from "./collection";
import type { RunOutcome } from "./outcomes";
import type { RepairEvent } from "./records";

export interface CollectRepairInput {
  /** Already pseudonymised, or null when the client sent no subject. */
  subject: string | null;
  outcome: RunOutcome;
  /**
   * The generation record this repair belongs to. Absent for a shortcut the
   * user pasted in rather than generated here — in that case there is no
   * example to attach to and only the outcome can be recorded.
   */
  runId?: string | null;
  repair: RepairEvent;
}

export interface RepairCollectionReport {
  outcomeStored: boolean;
  repairAttached: boolean;
  /** Set when collection failed for an operational reason. */
  error?: string;
}

export async function collectRepair(
  input: CollectRepairInput,
): Promise<RepairCollectionReport> {
  if (!input.subject) return { outcomeStored: false, repairAttached: false };

  const subject = input.subject;
  return withCollectionDeadline(
    () => collectRepairInner({ ...input, subject }),
    () => ({ outcomeStored: false, repairAttached: false, error: "timeout" }),
  );
}

async function collectRepairInner(
  input: CollectRepairInput & { subject: string },
): Promise<RepairCollectionReport> {
  const report: RepairCollectionReport = {
    outcomeStored: false,
    repairAttached: false,
  };

  try {
    const outcomePermit = await tryAuthorizeCollection(input.subject, "outcomes-only");
    if (outcomePermit) {
      const stored = await recordOutcome(outcomePermit, input.outcome);
      report.outcomeStored = stored.stored;
    }

    if (input.runId) {
      const permit = await tryAuthorizeCollection(input.subject, "full-examples");
      if (permit) {
        // No `source` is passed on purpose. A repair is not a success signal,
        // and overwriting successSignalSource here would let a repair masquerade
        // as evidence that the shortcut ran. attachFeedback also scopes the
        // lookup to this subject, so a guessed runId reaches nothing.
        const updated = await attachFeedback(permit, {
          runId: input.runId,
          repairs: [input.repair],
        });
        report.repairAttached = updated.updated;
      }
    }
  } catch (err) {
    // Deliberately swallowed, as in collect-run: the user gets their repaired
    // shortcut whether or not any of this was retained.
    report.error = err instanceof Error ? err.name : "unknown";
  }

  return report;
}
