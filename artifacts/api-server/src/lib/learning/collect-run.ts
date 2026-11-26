/**
 * The bridge between a finished run and the collection write path.
 *
 * This is the *only* place the request path touches collection, and it is
 * deliberately total: it never throws, and every failure inside it degrades to
 * "nothing was collected". A consent lookup that times out, a database that is
 * down, a redaction that refuses — none of them may turn a successful shortcut
 * generation into a 500. Collection is strictly subordinate to the product.
 *
 * The two tiers are authorised separately rather than once at the highest
 * level. A subject who granted `outcomes-only` still gets their metrics stored;
 * they simply never reach the example write. Authorising once at the top and
 * branching afterwards would work today and quietly over-collect the first time
 * someone reordered the branches.
 */

import { getActionByIdentifier } from "../shortcuts/catalog";
import type { PipelineResult } from "../shortcuts/pipeline-types";
import {
  recordInteraction,
  recordOutcome,
  tryAuthorizeCollection,
  type CollectionRefusal,
} from "./collection";
import type { RunOutcome } from "./outcomes";
import { pseudonymize } from "./privacy";
import { draftFromRun } from "./records";

/**
 * Turns a client-supplied anonymous id into a pseudonym.
 *
 * The raw value never leaves this function — everything downstream, including
 * every database column and log line, sees only the hash. A too-short value is
 * rejected rather than accepted, because a guessable subject id would let one
 * client read or purge another's records.
 */
export function subjectPseudonymFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 16 || trimmed.length > 200) return null;
  return pseudonymize(trimmed);
}

export interface CollectRunInput {
  /** Already pseudonymised, or null when the client sent no subject. */
  subject: string | null;
  outcome: RunOutcome;
  description: string;
  result: PipelineResult | null;
  targetIosVersion?: string | null;
  appVersion?: string | null;
}

export interface CollectionReport {
  outcomeStored: boolean;
  exampleStored: boolean;
  deduplicated?: boolean;
  status?: "active" | "quarantined";
  quarantineReasons?: string[];
  refusedBecause?: CollectionRefusal;
  /** Set when collection failed for an operational reason. */
  error?: string;
}

const NOTHING: CollectionReport = Object.freeze({
  outcomeStored: false,
  exampleStored: false,
});

/**
 * Collection is awaited before the response is sent, because on autoscale the
 * container can be frozen the moment a response completes and a floating
 * promise would simply be lost. That makes a slow database a latency problem
 * for the user, so the whole thing races a deadline: past it, the caller stops
 * waiting and the user gets their shortcut. Any write still in flight may land
 * afterwards, which is harmless — nothing downstream depends on this report.
 */
export const COLLECTION_DEADLINE_MS = 1_500;

/** Shared by every collection entrypoint so they all degrade identically. */
export async function withCollectionDeadline<T>(
  work: () => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), COLLECTION_DEADLINE_MS);
  });

  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectRun(input: CollectRunInput): Promise<CollectionReport> {
  if (!input.subject) return { ...NOTHING };

  const subject = input.subject;
  return withCollectionDeadline(
    () => collectRunInner({ ...input, subject }),
    () => ({ outcomeStored: false, exampleStored: false, error: "timeout" }),
  );
}

async function collectRunInner(
  input: CollectRunInput & { subject: string },
): Promise<CollectionReport> {
  const report: CollectionReport = { outcomeStored: false, exampleStored: false };

  try {
    const outcomePermit = await tryAuthorizeCollection(input.subject, "outcomes-only");
    if (outcomePermit) {
      const stored = await recordOutcome(outcomePermit, input.outcome);
      report.outcomeStored = stored.stored;
    }

    if (input.result) {
      const examplePermit = await tryAuthorizeCollection(input.subject, "redacted-examples");
      if (examplePermit) {
        const draft = draftFromRun({
          runId: input.outcome.runId,
          request: input.description,
          result: input.result,
          outcome: input.outcome.outcome,
          provenance: input.outcome.provenance,
          targetIosVersion: input.targetIosVersion ?? null,
          appVersion: input.appVersion ?? null,
          catalogHas: (identifier) => getActionByIdentifier(identifier) !== undefined,
        });

        const stored = await recordInteraction(examplePermit, draft);
        report.exampleStored = stored.stored;
        if (stored.deduplicated !== undefined) report.deduplicated = stored.deduplicated;
        if (stored.status) report.status = stored.status;
        if (stored.quarantineReasons?.length) {
          report.quarantineReasons = stored.quarantineReasons;
        }
        if (stored.refusedBecause) report.refusedBecause = stored.refusedBecause;
      }
    }
  } catch (err) {
    // Deliberately swallowed. The caller logs the report; the user gets their
    // shortcut either way.
    report.error = err instanceof Error ? err.name : "unknown";
  }

  return report;
}
