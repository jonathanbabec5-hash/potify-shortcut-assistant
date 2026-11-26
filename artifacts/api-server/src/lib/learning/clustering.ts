/**
 * Failure clustering.
 *
 * Individual failures are close to useless for deciding what to fix — there are
 * too many and each looks unique. Clustering answers the only question worth
 * asking: which single change would fix the most runs?
 *
 * The cluster key is the set of hard-error stages plus the ungrounded action
 * identifiers involved. Both come from structured fields, never from message
 * text, so the clustering is stable across message wording changes.
 *
 * Pure functions over a minimal record shape, so this works identically on rows
 * read from the database and on drafts held in memory.
 */

import type { IRValidationStage } from "../shortcuts/pipeline-types";
import type { RetrievedSchemaRef, ValidationEvent } from "./records";

export interface ClusterableRecord {
  id: string;
  outcome: string;
  validation: ValidationEvent[];
  retrievedSchemas: RetrievedSchemaRef[];
  actionSequence: string[];
  /** Collapsed duplicates count as their true frequency. */
  occurrenceCount: number;
  qualityScore: number;
  /** Redacted. Used only as a human-readable exemplar. */
  requestRedacted: string;
}

export interface FailureCluster {
  key: string;
  /** Distinct hard-error stages shared by every member. */
  stages: IRValidationStage[];
  /** Action identifiers that could not be grounded in the catalog. */
  unknownIdentifiers: string[];
  /** Sum of occurrenceCount — the real number of affected runs. */
  size: number;
  /** Distinct stored records. */
  recordCount: number;
  recordIds: string[];
  meanQuality: number;
  /** One redacted request, to make the cluster legible in a report. */
  exemplar: string;
}

const SUCCESS_OUTCOMES = new Set(["ready"]);

function clusterKeyOf(record: ClusterableRecord): {
  key: string;
  stages: IRValidationStage[];
  unknown: string[];
} {
  const stages = [
    ...new Set(record.validation.filter((v) => !v.advisory).map((v) => v.stage)),
  ].sort();
  const unknown = [
    ...new Set(
      record.retrievedSchemas.filter((s) => s.kind === "unknown").map((s) => s.identifier),
    ),
  ].sort();

  // A run with no hard errors that still is not "ready" failed at the
  // completion gate rather than at validation; that is its own cluster.
  const bucket =
    stages.length > 0
      ? stages.join("+")
      : SUCCESS_OUTCOMES.has(record.outcome)
        ? "none"
        : `outcome:${record.outcome}`;

  return { key: `${bucket}|${unknown.join(",")}`, stages, unknown };
}

/**
 * Groups failing records. Successful runs are excluded — they are measured
 * elsewhere and would otherwise dominate the largest cluster.
 */
export function clusterFailures(
  records: readonly ClusterableRecord[],
): FailureCluster[] {
  const groups = new Map<string, { stages: IRValidationStage[]; unknown: string[]; members: ClusterableRecord[] }>();

  for (const record of records) {
    if (SUCCESS_OUTCOMES.has(record.outcome) && record.validation.every((v) => v.advisory)) {
      continue;
    }
    const { key, stages, unknown } = clusterKeyOf(record);
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(record);
    } else {
      groups.set(key, { stages, unknown, members: [record] });
    }
  }

  const clusters: FailureCluster[] = [];
  for (const [key, group] of groups) {
    const size = group.members.reduce((n, m) => n + Math.max(1, m.occurrenceCount), 0);
    const meanQuality =
      group.members.reduce((n, m) => n + m.qualityScore, 0) / group.members.length;
    clusters.push({
      key,
      stages: group.stages,
      unknownIdentifiers: group.unknown,
      size,
      recordCount: group.members.length,
      recordIds: group.members.map((m) => m.id),
      meanQuality: Number(meanQuality.toFixed(4)),
      exemplar: group.members[0]!.requestRedacted,
    });
  }

  // Largest first, then most records, then key for a stable order.
  return clusters.sort(
    (a, b) => b.size - a.size || b.recordCount - a.recordCount || a.key.localeCompare(b.key),
  );
}

export interface ClusterSummary {
  totalFailures: number;
  clusters: number;
  /** Share of failures covered by the largest cluster. */
  topClusterShare: number;
  byStage: Record<string, number>;
}

export function summarizeClusters(clusters: readonly FailureCluster[]): ClusterSummary {
  const totalFailures = clusters.reduce((n, c) => n + c.size, 0);
  const byStage: Record<string, number> = {};
  for (const cluster of clusters) {
    for (const stage of cluster.stages) {
      byStage[stage] = (byStage[stage] ?? 0) + cluster.size;
    }
  }
  return {
    totalFailures,
    clusters: clusters.length,
    topClusterShare:
      totalFailures === 0 ? 0 : Number(((clusters[0]?.size ?? 0) / totalFailures).toFixed(4)),
    byStage,
  };
}
