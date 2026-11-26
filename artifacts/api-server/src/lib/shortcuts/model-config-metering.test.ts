import { test } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { meterCompletions, stageLabelOf } from './model-config';
import { CostCeilingError, CostLedger, withCostLedger } from '../learning/cost';

function fakeClient(response: unknown = { usage: { prompt_tokens: 10, completion_tokens: 4 } }) {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: unknown) => {
          calls.push(body);
          return response;
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, calls };
}

const body = (name?: string) => ({
  model: 'test-model',
  ...(name ? { response_format: { type: 'json_schema', json_schema: { name } } } : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage labelling
// ─────────────────────────────────────────────────────────────────────────────

test('the stage label comes from the request json_schema name', () => {
  assert.equal(stageLabelOf(body('extract_checklist')), 'extract_checklist');
});

test('an unlabelled call still gets a stable label', () => {
  assert.equal(stageLabelOf(body()), 'unlabelled:test-model');
  assert.equal(stageLabelOf(undefined), 'unlabelled');
  assert.equal(stageLabelOf({}), 'unlabelled');
});

// ─────────────────────────────────────────────────────────────────────────────
// Metering
// ─────────────────────────────────────────────────────────────────────────────

test('usage is recorded against the stage that produced it', async () => {
  const { client } = fakeClient();
  meterCompletions(client);
  const ledger = new CostLedger();

  await withCostLedger(ledger, async () => {
    await client.chat.completions.create(body('generate_ir') as never);
  });

  const summary = ledger.summary();
  assert.equal(summary.totalTokens, 14);
  assert.equal(summary.byStage.length, 1);
  assert.equal(summary.byStage[0]!.stage, 'generate_ir');
  assert.equal(summary.byStage[0]!.model, 'test-model');
});

test('the wrapper is actually installed — metering is not silently skipped', async () => {
  // Guards the failure mode where the SDK hands back a fresh completions object
  // on each access, so the wrapper is written to an orphan and never fires.
  const { client } = fakeClient();
  meterCompletions(client);
  const ledger = new CostLedger();
  await withCostLedger(ledger, async () => {
    await client.chat.completions.create(body('a') as never);
    await client.chat.completions.create(body('b') as never);
  });
  assert.equal(ledger.summary().calls, 2);
});

test('the response is returned untouched', async () => {
  const payload = { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ index: 0 }] };
  const { client } = fakeClient(payload);
  meterCompletions(client);
  const result = await client.chat.completions.create(body('x') as never);
  assert.deepEqual(result, payload);
});

test('a response with no usage field does not break the call', async () => {
  const { client } = fakeClient({ choices: [] });
  meterCompletions(client);
  const ledger = new CostLedger();
  await withCostLedger(ledger, async () => {
    await assert.doesNotReject(() => client.chat.completions.create(body('x') as never));
  });
  assert.equal(ledger.summary().totalTokens, 0);
});

test('with no ledger installed the call passes straight through', async () => {
  const { client, calls } = fakeClient();
  meterCompletions(client);
  await assert.doesNotReject(() => client.chat.completions.create(body('x') as never));
  assert.equal(calls.length, 1);
});

test('a blown ceiling blocks the next request before it is issued', async () => {
  const { client, calls } = fakeClient();
  meterCompletions(client);
  const ledger = new CostLedger(10);

  await withCostLedger(ledger, async () => {
    await client.chat.completions.create(body('stage-1') as never); // 14 tokens
    await assert.rejects(
      () => client.chat.completions.create(body('stage-2') as never),
      CostCeilingError,
    );
  });

  assert.equal(calls.length, 1, 'the over-budget request must never reach the provider');
});
