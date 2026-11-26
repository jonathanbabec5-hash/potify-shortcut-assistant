/**
 * Per-run token accounting and cost ceiling.
 *
 * Two jobs:
 *   1. Measure. Cost-per-run is part of the outcome record and is one of the
 *      promotion gates — a candidate that is 3% more accurate and 4x more
 *      expensive must be blocked, which requires the number.
 *   2. Bound. A runaway repair loop must not be able to spend without limit.
 *
 * The ledger is ambient (AsyncLocalStorage) so instrumenting a call site is one
 * defensive line and no signature changes. If no ledger is installed —
 * unit tests, scripts — recording is a silent no-op and nothing is bounded.
 *
 * The default ceiling is deliberately well above a normal full-pipeline run, so
 * enabling this changes no existing behaviour. It exists to stop pathological
 * runs, not to tune spend.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_RUN_TOKEN_CEILING = (() => {
  const raw = process.env.LEARNING_RUN_TOKEN_CEILING;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200_000;
})();

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StageCost extends TokenUsage {
  stage: string;
  model: string;
  calls: number;
  totalTokens: number;
}

export interface CostSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byStage: StageCost[];
  ceiling: number;
  exceeded: boolean;
}

/**
 * Cost for a path that does not meter tokens.
 *
 * Recorded as explicit zeroes rather than an estimate: a guessed token count
 * would be indistinguishable from a measured one once stored, and efficiency
 * metrics built on it would be quietly wrong.
 */
export const UNMETERED_COST: CostSummary = Object.freeze({
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  byStage: [],
  ceiling: 0,
  exceeded: false,
});

export class CostCeilingError extends Error {
  readonly spent: number;
  readonly ceiling: number;
  constructor(stage: string, spent: number, ceiling: number) {
    super(
      `Token ceiling exceeded before stage "${stage}": ${spent} of ${ceiling} tokens already spent on this run.`,
    );
    this.name = "CostCeilingError";
    this.spent = spent;
    this.ceiling = ceiling;
  }
}

export class CostLedger {
  readonly ceiling: number;
  private readonly stages = new Map<string, StageCost>();

  constructor(ceiling: number = DEFAULT_RUN_TOKEN_CEILING) {
    this.ceiling = ceiling;
  }

  record(stage: string, model: string, usage: TokenUsage): void {
    const prompt = Number.isFinite(usage.promptTokens) ? usage.promptTokens : 0;
    const completion = Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : 0;

    const existing = this.stages.get(stage);
    if (existing) {
      existing.promptTokens += prompt;
      existing.completionTokens += completion;
      existing.totalTokens += prompt + completion;
      existing.calls += 1;
      return;
    }
    this.stages.set(stage, {
      stage,
      model,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      calls: 1,
    });
  }

  get totalTokens(): number {
    let total = 0;
    for (const s of this.stages.values()) total += s.totalTokens;
    return total;
  }

  get exceeded(): boolean {
    return this.totalTokens > this.ceiling;
  }

  /**
   * Called before starting a stage. Throws when the budget is already blown,
   * which stops the *next* call rather than truncating one in flight.
   */
  assertWithinCeiling(stage: string): void {
    const spent = this.totalTokens;
    if (spent > this.ceiling) {
      throw new CostCeilingError(stage, spent, this.ceiling);
    }
  }

  summary(): CostSummary {
    const byStage = [...this.stages.values()].sort((a, b) =>
      a.stage.localeCompare(b.stage),
    );
    let calls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const s of byStage) {
      calls += s.calls;
      promptTokens += s.promptTokens;
      completionTokens += s.completionTokens;
    }
    return {
      calls,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      byStage,
      ceiling: this.ceiling,
      exceeded: promptTokens + completionTokens > this.ceiling,
    };
  }
}

// ── Ambient ledger ────────────────────────────────────────────────────────────

const ledgerStore = new AsyncLocalStorage<CostLedger>();

export function withCostLedger<T>(ledger: CostLedger, fn: () => T): T {
  return ledgerStore.run(ledger, fn);
}

export function currentLedger(): CostLedger | undefined {
  return ledgerStore.getStore();
}

/**
 * Instrumentation helper for LLM call sites.
 *
 * Defensive by construction: an unexpected usage shape, or no active ledger,
 * must never turn a working generation into an error. Accounting is not worth
 * a user-visible failure.
 */
export function recordUsage(
  stage: string,
  model: string,
  usage: unknown,
): void {
  try {
    const ledger = ledgerStore.getStore();
    if (!ledger) return;
    const u = usage as
      | { prompt_tokens?: number; completion_tokens?: number }
      | null
      | undefined;
    ledger.record(stage, model, {
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
    });
  } catch {
    // accounting must never break inference
  }
}

/** Guard for a call site about to spend. No-op when no ledger is installed. */
export function assertBudget(stage: string): void {
  ledgerStore.getStore()?.assertWithinCeiling(stage);
}
