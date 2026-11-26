import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CostLedger } from './cost';
import {
  aggregateOutcomes,
  compareBenchmarks,
  measureRun,
  provenanceFrom,
  type RunOutcome,
} from './outcomes';
import type { PipelineResult } from '../shortcuts/pipeline-types';

const NOW = 1_800_000_000_000;
const COST = new CostLedger().summary();
const PROV = provenanceFrom({
  catalogVersion: '1',
  catalogHash: 'abc',
  modelId: 'model-a',
  systemPromptHash: 'def',
});

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    shortcut: { WFWorkflowActions: [] },
    actions: [{}, {}],
    warnings: [],
    minimumIosVersion: '17.0',
    explanation: 'does a thing',
    uncertainty: [],
    alternatives: [],
    checklistSatisfied: true,
    checklist: [{}, {}, {}],
    completionStatus: {
      satisfied: true,
      status: 'ready',
      blockingFindings: [],
    },
    hardIrErrors: [],
    id: 'stored-id',
    ...overrides,
  } as unknown as PipelineResult;
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    startedAt: NOW,
    finishedAt: NOW + 1500,
    cost: COST,
    provenance: PROV,
    descriptionLength: 42,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome derivation
// ─────────────────────────────────────────────────────────────────────────────

test('a satisfied result with a stored file is ready and import-offered', () => {
  const o = measureRun(base({ result: pipelineResult() }) as never);
  assert.equal(o.outcome, 'ready');
  assert.equal(o.importOffered, true);
  assert.equal(o.executableActionCount, 2);
  assert.equal(o.checklistItemCount, 3);
  assert.equal(o.durationMs, 1500);
});

test('a satisfied status with no stored file is NOT counted as import-offered', () => {
  const o = measureRun(base({ result: pipelineResult({ id: undefined }) }) as never);
  assert.equal(o.importOffered, false);
});

test('a satisfied completion status with an unsatisfied checklist is not import-offered', () => {
  const o = measureRun(
    base({ result: pipelineResult({ checklistSatisfied: false }) }) as never,
  );
  assert.equal(o.importOffered, false);
});

test('a missing completion status is "unverified", never a success', () => {
  const o = measureRun(
    base({ result: pipelineResult({ completionStatus: undefined }) }) as never,
  );
  assert.equal(o.outcome, 'unverified');
  assert.notEqual(o.outcome, 'ready');
  assert.equal(o.importOffered, false);
});

test('no result at all is an error', () => {
  const o = measureRun(base({ result: null, errorKind: 'provider' }) as never);
  assert.equal(o.outcome, 'error');
  assert.equal(o.errorKind, 'provider');
  assert.equal(o.importOffered, false);
});

test('a blown token ceiling is its own outcome', () => {
  const o = measureRun(base({ result: null, errorKind: 'cost-ceiling' }) as never);
  assert.equal(o.outcome, 'cost-exceeded');
});

test('failing statuses are carried through verbatim', () => {
  for (const status of ['incomplete', 'unsupported', 'validation-failed'] as const) {
    const o = measureRun(
      base({
        result: pipelineResult({
          checklistSatisfied: false,
          id: undefined,
          completionStatus: { satisfied: false, status, blockingFindings: [{}] },
        } as never),
      }) as never,
    );
    assert.equal(o.outcome, status);
    assert.equal(o.importOffered, false);
    assert.equal(o.unsatisfiedItemCount, 1);
  }
});

test('hard error stages are de-duplicated and sorted', () => {
  const o = measureRun(
    base({
      result: pipelineResult({
        hardIrErrors: [
          { stage: 'grounding' },
          { stage: 'grounding' },
          { stage: 'checklist' },
        ],
      } as never),
    }) as never,
  );
  assert.deepEqual(o.hardErrorStages, ['checklist', 'grounding']);
});

// ─────────────────────────────────────────────────────────────────────────────
// The record must not contain user text
// ─────────────────────────────────────────────────────────────────────────────

test('an outcome record carries no user text — only shape and classes', () => {
  const o = measureRun(
    base({
      result: pipelineResult({ explanation: 'Send a message to Jane Doe' }),
      descriptionLength: 26,
      redactedClasses: ['person-name'],
      containedSecret: false,
    }) as never,
  );
  const serialised = JSON.stringify(o);
  assert.ok(!serialised.includes('Jane'));
  assert.ok(!serialised.includes('Send a message'));
  assert.equal(o.descriptionLength, 26);
  assert.deepEqual(o.redactedClasses, ['person-name']);
});

test('provenance is always attached', () => {
  const o = measureRun(base({ result: pipelineResult() }) as never);
  assert.equal(o.provenance.modelId, 'model-a');
  assert.ok(o.provenance.validatorVersion.length > 0);
  assert.ok(o.provenance.pipelineVersion.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation and benchmark comparison
// ─────────────────────────────────────────────────────────────────────────────

function outcome(kind: RunOutcome['outcome'], tokens = 1000): RunOutcome {
  return measureRun(
    base({
      result:
        kind === 'ready'
          ? pipelineResult()
          : pipelineResult({
              checklistSatisfied: false,
              id: undefined,
              completionStatus:
                kind === 'unverified'
                  ? undefined
                  : { satisfied: false, status: 'incomplete', blockingFindings: [] },
              hardIrErrors: [{ stage: 'grounding' }],
            } as never),
      cost: { ...COST, totalTokens: tokens },
    }) as never,
  );
}

test('aggregate reports rates over an empty set without dividing by zero', () => {
  const agg = aggregateOutcomes([]);
  assert.equal(agg.runs, 0);
  assert.equal(agg.readyRate, 0);
  assert.equal(agg.meanTokens, 0);
});

test('aggregate computes ready rate, failure rate, and per-stage failures', () => {
  const agg = aggregateOutcomes([
    outcome('ready'),
    outcome('ready'),
    outcome('incomplete'),
    outcome('unverified'),
  ]);
  assert.equal(agg.runs, 4);
  assert.equal(agg.readyRate, 0.5);
  assert.equal(agg.failureRate, 0.5);
  assert.equal(agg.unverifiedCount, 1);
  assert.equal(agg.failuresByStage['grounding'], 2);
});

test('a challenger that improves the ready rate without regressing is an improvement', () => {
  const champion = aggregateOutcomes([outcome('ready'), outcome('incomplete')]);
  const challenger = aggregateOutcomes([outcome('ready'), outcome('ready')]);
  const cmp = compareBenchmarks(champion, challenger);
  assert.equal(cmp.improved, true);
  assert.equal(cmp.regressed, false);
  assert.ok(cmp.readyRateDelta > 0);
});

test('a challenger that lowers the ready rate is a regression, however cheap', () => {
  const champion = aggregateOutcomes([outcome('ready'), outcome('ready', 5000)]);
  const challenger = aggregateOutcomes([outcome('ready', 10), outcome('incomplete', 10)]);
  const cmp = compareBenchmarks(champion, challenger);
  assert.equal(cmp.regressed, true);
  assert.equal(cmp.improved, false);
  assert.ok(cmp.tokenDelta < 0, 'cheaper, and still blocked');
});

test('an identical challenger is not an improvement', () => {
  const same = aggregateOutcomes([outcome('ready'), outcome('incomplete')]);
  assert.equal(compareBenchmarks(same, same).improved, false);
});
