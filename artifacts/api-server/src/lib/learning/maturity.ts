/**
 * What is actually proven, derived from live counts.
 *
 * ## Why this exists
 *
 * Every part of the learning layer is implemented, and almost none of it has
 * ever run on real data. That combination is dangerous to describe in prose,
 * because "implemented" reads as "working" and a document claiming a capability
 * cannot be contradicted by the database. So no level here is ever declared: each
 * one is computed from row counts and environment facts at the moment it is
 * asked for. If the corpus is empty, nothing can report itself as proven, no
 * matter what anyone writes in a README.
 *
 * ## The distinction that matters most
 *
 * `has-not-run` and `cannot-run` look identical in a status table and mean
 * opposite things. The first is a to-do: everything is in place and nobody has
 * pressed the button. The second is a blocker: pressing the button would fail,
 * and no amount of trying will change that until a precondition is fixed. Fusing
 * them into "not working" is how a blocker sits unnoticed for months, and how a
 * to-do gets escalated as an outage.
 *
 * ## The cap rule
 *
 * Nothing downstream of collection can be `proven-real` while zero interaction
 * records exist. A benchmark run against fixtures proves the harness works; it
 * proves nothing about the data pipeline that is supposed to feed it. The cap is
 * applied mechanically rather than left to a judgement call.
 */

import { count } from "drizzle-orm";
import {
  db,
  consentGrants,
  interactionRecords,
  promotionDecisions,
  runOutcomes,
  trainingBatches,
  trainingCandidates,
} from "@workspace/db";

import { classifyCoverage } from "./eval-coverage";
import { EVAL_SET } from "./eval-set";
import { HOLDOUT_SET } from "./eval-holdout";

export type EvidenceLevel =
  /** Preconditions are missing; running it now would fail. Actionable blocker. */
  | "cannot-run"
  /** Everything needed is present. It has simply never been exercised. */
  | "has-not-run"
  /** Exercised, but only against fixtures or synthetic input. */
  | "tested-synthetic"
  /** Exercised against real, consented records. */
  | "proven-real";

export interface CapabilityEvidence {
  id: string;
  level: EvidenceLevel;
  /** The counts and facts the level was derived from. Never a claim. */
  basis: string;
  /** Present only for `cannot-run`: what must change first. */
  blocker?: string;
}

export interface MaturityAssessment {
  assessedAt: number;
  counts: {
    consentGrants: number;
    interactionRecords: number;
    runOutcomes: number;
    trainingBatches: number;
    trainingCandidates: number;
    promotionDecisions: number;
  };
  suites: {
    evalRunnable: number;
    evalCannotRun: number;
    holdoutRunnable: number;
    holdoutCannotRun: number;
  };
  modelProviderConfigured: boolean;
  capabilities: CapabilityEvidence[];
  /**
   * True when at least one real consented interaction record exists.
   *
   * The single fact that gates every `proven-real` level below. While this is
   * false, the learning half of the system has been tested but not demonstrated.
   */
  hasRealCorpus: boolean;
}

export async function assessMaturity(now: number = Date.now()): Promise<MaturityAssessment> {
  const [grants, records, outcomes, batches, candidates, decisions] = await Promise.all([
    db.select({ n: count() }).from(consentGrants),
    db.select({ n: count() }).from(interactionRecords),
    db.select({ n: count() }).from(runOutcomes),
    db.select({ n: count() }).from(trainingBatches),
    db.select({ n: count() }).from(trainingCandidates),
    db.select({ n: count() }).from(promotionDecisions),
  ]);

  const counts = {
    consentGrants: Number(grants[0]?.n ?? 0),
    interactionRecords: Number(records[0]?.n ?? 0),
    runOutcomes: Number(outcomes[0]?.n ?? 0),
    trainingBatches: Number(batches[0]?.n ?? 0),
    trainingCandidates: Number(candidates[0]?.n ?? 0),
    promotionDecisions: Number(decisions[0]?.n ?? 0),
  };

  const evalCoverage = classifyCoverage(EVAL_SET);
  const holdoutCoverage = classifyCoverage(HOLDOUT_SET);
  const suites = {
    evalRunnable: evalCoverage.runnable.length,
    evalCannotRun: evalCoverage.unrunnable.length,
    holdoutRunnable: holdoutCoverage.runnable.length,
    holdoutCannotRun: holdoutCoverage.unrunnable.length,
  };

  const modelProviderConfigured = Boolean(
    process.env.OPENROUTER_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  );
  const hasRealCorpus = counts.interactionRecords > 0;

  /** Caps a level at `tested-synthetic` while no real corpus exists. */
  const capped = (level: EvidenceLevel): EvidenceLevel =>
    level === "proven-real" && !hasRealCorpus ? "tested-synthetic" : level;

  const capabilities: CapabilityEvidence[] = [
    {
      id: "consent-capture",
      level: counts.consentGrants > 0 ? "tested-synthetic" : "has-not-run",
      basis: `${counts.consentGrants} consent grant row(s). Not distinguishable from test fixtures without a real corpus.`,
    },
    {
      id: "interaction-collection",
      level: capped(counts.interactionRecords > 0 ? "proven-real" : "has-not-run"),
      basis: `${counts.interactionRecords} interaction record(s) stored.`,
    },
    {
      id: "outcome-measurement",
      level: counts.runOutcomes > 0 ? "tested-synthetic" : "has-not-run",
      basis: `${counts.runOutcomes} run outcome(s) measured. Measuring an outcome does not require consent, so this can be non-zero while collection is empty.`,
    },
    {
      id: "batch-freezing",
      level: counts.interactionRecords === 0
        ? "cannot-run"
        : counts.trainingBatches > 0
          ? capped("proven-real")
          : "has-not-run",
      basis: `${counts.trainingBatches} frozen batch(es) over ${counts.interactionRecords} record(s).`,
      ...(counts.interactionRecords === 0
        ? { blocker: "No interaction records exist, so there is nothing to freeze into a batch." }
        : {}),
    },
    {
      id: "candidate-building",
      level: counts.trainingBatches === 0
        ? "cannot-run"
        : counts.trainingCandidates > 0
          ? capped("proven-real")
          : "has-not-run",
      basis: `${counts.trainingCandidates} candidate(s) built.`,
      ...(counts.trainingBatches === 0
        ? { blocker: "A candidate is built from a frozen batch, and none exists." }
        : {}),
    },
    {
      id: "benchmark-comparison",
      level: !modelProviderConfigured
        ? "cannot-run"
        : suites.evalRunnable === 0 || suites.holdoutRunnable === 0
          ? "cannot-run"
          : counts.trainingCandidates > 0
            ? capped("proven-real")
            : "has-not-run",
      basis:
        `${suites.evalRunnable} eval case(s) and ${suites.holdoutRunnable} held-out case(s) are scoreable ` +
        `against the current catalog; ${suites.evalCannotRun + suites.holdoutCannotRun} cannot be scored.`,
      ...(!modelProviderConfigured
        ? {
            blocker:
              "No model provider is reachable, so no benchmark can be run. This is an account " +
              "entitlement issue, not a configuration mistake.",
          }
        : suites.evalRunnable === 0 || suites.holdoutRunnable === 0
          ? {
              blocker:
                "A suite has no scoreable cases: every case names an action the catalog does not " +
                "define, so both variants would fail identically and the delta would always be zero.",
            }
          : {}),
    },
    {
      id: "human-promotion",
      level: counts.trainingCandidates === 0
        ? "cannot-run"
        : counts.promotionDecisions > 0
          ? capped("proven-real")
          : "has-not-run",
      basis: `${counts.promotionDecisions} recorded promotion decision(s).`,
      ...(counts.trainingCandidates === 0
        ? { blocker: "There is no candidate to decide about." }
        : {}),
    },
    {
      id: "retention-sweep",
      // Deliberately not inferred from the absence of expired rows: an empty
      // corpus and a swept corpus look the same, and guessing between them would
      // be exactly the kind of unearned claim this module exists to prevent.
      level: "has-not-run",
      basis:
        "A sweep leaves no durable trace by design, so this cannot be raised above " +
        "has-not-run from the database alone. Treat it as unproven until a sweep is " +
        "observed in an operator's own output.",
    },
  ];

  return {
    assessedAt: now,
    counts,
    suites,
    modelProviderConfigured,
    capabilities,
    hasRealCorpus,
  };
}

const LEVEL_MARK: Readonly<Record<EvidenceLevel, string>> = Object.freeze({
  "cannot-run": "✗ CANNOT RUN",
  "has-not-run": "· has not run",
  "tested-synthetic": "~ tested (synthetic)",
  "proven-real": "✓ proven (real records)",
});

export function describeMaturity(assessment: MaturityAssessment): string {
  const lines = [
    `Evidence as of ${new Date(assessment.assessedAt).toISOString()}`,
    assessment.hasRealCorpus
      ? "  Real consented corpus: present."
      : "  Real consented corpus: EMPTY — nothing downstream can be better than synthetically tested.",
    "",
  ];

  for (const c of assessment.capabilities) {
    lines.push(`  ${LEVEL_MARK[c.level].padEnd(24)} ${c.id}`);
    lines.push(`      ${c.basis}`);
    if (c.blocker) lines.push(`      blocker: ${c.blocker}`);
  }

  return lines.join("\n");
}
