import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CostLedger,
  CostCeilingError,
  assertBudget,
  currentLedger,
  recordUsage,
  withCostLedger,
} from './cost';

test('records usage and aggregates repeat calls to the same stage', () => {
  const ledger = new CostLedger(10_000);
  ledger.record('stage-1', 'model-a', { promptTokens: 100, completionTokens: 50 });
  ledger.record('stage-1', 'model-a', { promptTokens: 200, completionTokens: 25 });
  ledger.record('stage-2', 'model-a', { promptTokens: 10, completionTokens: 5 });

  const summary = ledger.summary();
  assert.equal(summary.calls, 3);
  assert.equal(summary.promptTokens, 310);
  assert.equal(summary.completionTokens, 80);
  assert.equal(summary.totalTokens, 390);
  assert.equal(summary.byStage.length, 2);
  assert.equal(summary.byStage.find((s) => s.stage === 'stage-1')!.calls, 2);
});

test('stages are reported in a stable order', () => {
  const ledger = new CostLedger();
  ledger.record('z-stage', 'm', { promptTokens: 1, completionTokens: 1 });
  ledger.record('a-stage', 'm', { promptTokens: 1, completionTokens: 1 });
  assert.deepEqual(
    ledger.summary().byStage.map((s) => s.stage),
    ['a-stage', 'z-stage'],
  );
});

test('the ceiling is not breached by usage that stays under it', () => {
  const ledger = new CostLedger(1_000);
  ledger.record('s', 'm', { promptTokens: 500, completionTokens: 499 });
  assert.equal(ledger.exceeded, false);
  assert.doesNotThrow(() => ledger.assertWithinCeiling('next'));
});

test('exceeding the ceiling blocks the next stage, not the one in flight', () => {
  const ledger = new CostLedger(1_000);
  ledger.record('s1', 'm', { promptTokens: 900, completionTokens: 200 });
  assert.equal(ledger.exceeded, true);
  assert.throws(
    () => ledger.assertWithinCeiling('s2'),
    (err: unknown) => {
      assert.ok(err instanceof CostCeilingError);
      assert.equal(err.ceiling, 1_000);
      assert.equal(err.spent, 1_100);
      assert.match(err.message, /s2/);
      return true;
    },
  );
});

test('a fresh ledger reports zero rather than NaN', () => {
  const summary = new CostLedger().summary();
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.calls, 0);
  assert.equal(summary.exceeded, false);
  assert.deepEqual(summary.byStage, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ambient ledger — instrumentation must never break inference
// ─────────────────────────────────────────────────────────────────────────────

test('recordUsage is a silent no-op with no ledger installed', () => {
  assert.equal(currentLedger(), undefined);
  assert.doesNotThrow(() => recordUsage('stage', 'model', { prompt_tokens: 5, completion_tokens: 5 }));
  assert.doesNotThrow(() => assertBudget('stage'));
});

test('recordUsage tolerates a malformed usage object', () => {
  const ledger = new CostLedger();
  withCostLedger(ledger, () => {
    assert.doesNotThrow(() => recordUsage('s', 'm', undefined));
    assert.doesNotThrow(() => recordUsage('s', 'm', null));
    assert.doesNotThrow(() => recordUsage('s', 'm', 'nonsense'));
    assert.doesNotThrow(() => recordUsage('s', 'm', { prompt_tokens: 'x' }));
  });
  assert.equal(ledger.totalTokens, 0);
});

test('recordUsage writes to the ambient ledger', () => {
  const ledger = new CostLedger();
  withCostLedger(ledger, () => {
    recordUsage('stage-1', 'model-a', { prompt_tokens: 30, completion_tokens: 12 });
  });
  assert.equal(ledger.totalTokens, 42);
});

test('the ambient ledger survives await boundaries', async () => {
  const ledger = new CostLedger();
  await withCostLedger(ledger, async () => {
    recordUsage('before', 'm', { prompt_tokens: 1, completion_tokens: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    recordUsage('after', 'm', { prompt_tokens: 2, completion_tokens: 2 });
  });
  assert.equal(ledger.totalTokens, 6);
  assert.equal(ledger.summary().byStage.length, 2);
});

test('ledgers do not leak between concurrent runs', async () => {
  const a = new CostLedger();
  const b = new CostLedger();
  await Promise.all([
    withCostLedger(a, async () => {
      await new Promise((r) => setTimeout(r, 2));
      recordUsage('s', 'm', { prompt_tokens: 10, completion_tokens: 0 });
    }),
    withCostLedger(b, async () => {
      recordUsage('s', 'm', { prompt_tokens: 3, completion_tokens: 0 });
    }),
  ]);
  assert.equal(a.totalTokens, 10);
  assert.equal(b.totalTokens, 3);
});

test('assertBudget throws through the ambient ledger once over budget', () => {
  const ledger = new CostLedger(10);
  withCostLedger(ledger, () => {
    recordUsage('s1', 'm', { prompt_tokens: 20, completion_tokens: 0 });
    assert.throws(() => assertBudget('s2'), CostCeilingError);
  });
});
