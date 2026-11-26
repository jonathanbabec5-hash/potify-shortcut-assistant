/**
 * Active-learning prioritisation.
 *
 * Clustering says what is broken. This says what to work on next, and — more
 * usefully — what *kind* of work it is. A grounding failure on an uncatalogued
 * action is a catalog entry, not a prompt change; an invention failure is a
 * prompt change, not a catalog entry. Getting that wrong wastes the whole cycle.
 *
 * The score is intentionally simple and inspectable. An opaque ranking that
 * nobody can argue with is worse than a crude one that surfaces its reasoning,
 * because the output of this function is a human work queue, not an automated
 * action.
 */

import type { FailureCluster } from "./clustering";

export type RemediationKind =
  | "catalog-entry"
  | "prompt-revision"
  | "validator-rule"
  | "clarification-flow"
  | "eval-case"
  | "investigation";

export interface LabelingPriority {
  clusterKey: string;
  /** 0..1. Relative, not absolute — only the ordering is meaningful. */
  score: number;
  /** Runs this cluster accounts for. */
  affectedRuns: number;
  kind: RemediationKind;
  /** Plain-language statement of what to do and why it ranks here. */
  recommendation: string;
  exemplar: string;
  unknownIdentifiers: string[];
}

/**
 * How tractable each failure stage is.
 *
 * Grounding scores highest because the fix is mechanical and complete: add the
 * action to the catalog and every run in the cluster stops failing. Invention
 * and checklist failures need prompt or validator work whose effect is harder
 * to predict, so an equally large cluster there is worth less per unit of
 * effort.
 */
const STAGE_TRACTABILITY: Record<string, number> = Object.freeze({
  grounding: 1.0,
  parameters: 0.8,
  platform: 0.7,
  controlflow: 0.6,
  variables: 0.6,
  checklist: 0.5,
  invention: 0.5,
});

const STAGE_REMEDIATION: Record<string, RemediationKind> = Object.freeze({
  grounding: "catalog-entry",
  parameters: "validator-rule",
  platform: "validator-rule",
  controlflow: "prompt-revision",
  variables: "prompt-revision",
  checklist: "clarification-flow",
  invention: "prompt-revision",
});

function tractabilityOf(stages: readonly string[]): number {
  if (stages.length === 0) return 0.4;
  // A cluster is only as tractable as its least tractable stage — fixing one
  // stage of a multi-stage failure does not make the run pass.
  return Math.min(...stages.map((s) => STAGE_TRACTABILITY[s] ?? 0.4));
}

function remediationFor(cluster: FailureCluster): RemediationKind {
  if (cluster.unknownIdentifiers.length > 0) return "catalog-entry";
  if (cluster.stages.length === 0) return "investigation";
  const primary = [...cluster.stages].sort(
    (a, b) => (STAGE_TRACTABILITY[b] ?? 0) - (STAGE_TRACTABILITY[a] ?? 0),
  )[0]!;
  return STAGE_REMEDIATION[primary] ?? "investigation";
}

function describe(cluster: FailureCluster, kind: RemediationKind): string {
  const runs = `${cluster.size} run${cluster.size === 1 ? "" : "s"}`;
  switch (kind) {
    case "catalog-entry":
      return `Add catalog entries for ${cluster.unknownIdentifiers.join(", ") || "the missing identifiers"} — ${runs} fail grounding on them and would pass once catalogued.`;
    case "prompt-revision":
      return `Revise the Stage 3 prompt for ${cluster.stages.join(", ")} — ${runs} produce structurally invalid IR here.`;
    case "validator-rule":
      return `Tighten ${cluster.stages.join(", ")} validation — ${runs} reach Stage 4 with bindings the validator should have caught earlier.`;
    case "clarification-flow":
      return `Extend the clarify step — ${runs} fail the checklist gate, which usually means the requirement was never pinned down with the user.`;
    case "eval-case":
      return `Add an eval case — ${runs} share a failure the current set does not cover.`;
    default:
      return `Investigate — ${runs} fail with no hard validation error, so the cause is outside Stage 4.`;
  }
}

/**
 * Ranks clusters into a work queue.
 *
 * score = frequency share × tractability × severity
 *
 * Frequency uses the cluster's share of all failures rather than its raw count,
 * so the ranking is stable as the corpus grows. Severity rises as mean quality
 * falls — a cluster of near-miss runs matters less than a cluster of total
 * failures of the same size.
 */
export function prioritizeClusters(
  clusters: readonly FailureCluster[],
  options: { limit?: number } = {},
): LabelingPriority[] {
  const total = clusters.reduce((n, c) => n + c.size, 0);
  if (total === 0) return [];

  const ranked = clusters.map((cluster) => {
    const frequency = cluster.size / total;
    const tractability = tractabilityOf(cluster.stages);
    const severity = 1 - Math.min(1, Math.max(0, cluster.meanQuality));
    const kind = remediationFor(cluster);
    return {
      clusterKey: cluster.key,
      score: Number((frequency * tractability * severity).toFixed(4)),
      affectedRuns: cluster.size,
      kind,
      recommendation: describe(cluster, kind),
      exemplar: cluster.exemplar,
      unknownIdentifiers: cluster.unknownIdentifiers,
    };
  });

  ranked.sort((a, b) => b.score - a.score || b.affectedRuns - a.affectedRuns);
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}

/**
 * Clusters that should become permanent eval cases.
 *
 * A recurring failure with no eval coverage is how a regression gets reintroduced
 * after it is fixed. Anything above the threshold is worth pinning into the
 * held-out set before the fix lands, not after.
 */
export function suggestEvalCases(
  clusters: readonly FailureCluster[],
  options: { minRuns?: number; limit?: number } = {},
): LabelingPriority[] {
  const minRuns = options.minRuns ?? 3;
  const candidates = clusters.filter((c) => c.size >= minRuns);
  return prioritizeClusters(candidates, options).map((p) => ({
    ...p,
    kind: "eval-case" as const,
    recommendation: describe(
      candidates.find((c) => c.key === p.clusterKey)!,
      "eval-case",
    ),
  }));
}
