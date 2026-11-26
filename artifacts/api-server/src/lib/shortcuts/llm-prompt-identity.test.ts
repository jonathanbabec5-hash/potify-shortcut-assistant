/**
 * The production prompt must be unchanged by the candidate-adapter hook, and the
 * fingerprinted policy must contain nothing that varies per request.
 *
 * The adapter used to be a plain `adapterBlock = ""` string parameter, so safety
 * rested on every caller remembering not to pass one and on this file catching
 * it if they did. It is now a branded `AdapterBlock` that only the training
 * subtree can mint, so the request path cannot construct one at all. These tests
 * keep the original guarantees — the production prompt is an exact prefix of a
 * candidate prompt, and no candidate content survives into a later call — and
 * add the two the split introduced: the fingerprinted policy has no catalog in
 * it, and scoping actually reduces what we send.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { compactCatalogForPrompt } from "./catalog";
import { buildPromptPolicy, buildSystemPrompt } from "./llm";
import { selectActionSchemas } from "./schema-retrieval";
import { AdapterMintError, mintAdapterBlock } from "../learning/training/adapter-block";

/**
 * Importing the training mint from a test is fine: `training-isolation.test.ts`
 * walks the shipped graph from `app.ts` and skips `.test.ts` files, so this
 * import cannot make training reachable from a request.
 */
const ADAPTER = mintAdapterBlock({
  text: 'VERIFIED EXAMPLES (request -> action sequence):\n- "x" -> [a > b] depth=0',
  candidateId: "cand-test",
});

const SCOPE = selectActionSchemas({
  identifiers: ["is.workflow.actions.notification"],
  keywords: "send a notification",
});

test("an omitted adapter and an explicitly undefined adapter are the same prompt", () => {
  assert.equal(
    buildSystemPrompt({ schemas: SCOPE }),
    buildSystemPrompt({ schemas: SCOPE, adapter: undefined }),
  );
});

test("the production prompt carries no adapter content", () => {
  const production = buildSystemPrompt({ schemas: SCOPE });
  assert.ok(!production.includes("VERIFIED EXAMPLES"));
  assert.ok(!production.includes(ADAPTER.text));
});

test("an adapter only appends — the production prompt stays an exact prefix", () => {
  const production = buildSystemPrompt({ schemas: SCOPE });
  const withAdapter = buildSystemPrompt({ schemas: SCOPE, adapter: ADAPTER });

  // Prefix equality is the strong form of "nothing was changed, only added".
  assert.ok(
    withAdapter.startsWith(production),
    "adapter prompt must begin with the exact production prompt",
  );
  assert.ok(withAdapter.includes(ADAPTER.text));
  assert.ok(withAdapter.length > production.length);
});

test("a candidate prompt is never cached into the production path", () => {
  const before = buildSystemPrompt({ schemas: SCOPE });
  buildSystemPrompt({ schemas: SCOPE, adapter: ADAPTER });
  buildSystemPrompt({
    schemas: SCOPE,
    adapter: mintAdapterBlock({ text: "something else entirely", candidateId: "cand-other" }),
  });
  const after = buildSystemPrompt({ schemas: SCOPE });

  assert.equal(
    after,
    before,
    "an offline benchmark must not leave residue a later request could pick up",
  );
  assert.ok(!after.includes("something else entirely"));
});

test("the fingerprinted policy contains no per-request content", () => {
  const policy = buildPromptPolicy();

  // No adapter, ever.
  assert.ok(!policy.includes("VERIFIED EXAMPLES"));

  // No catalog listing. If the whole catalog were still inside the policy, the
  // policy hash would change whenever the catalog did and `catalogHash` would be
  // redundant — but worse, a per-request schema section inside the hashed string
  // would make the boot integrity check fail on every request.
  assert.ok(
    !policy.includes("is.workflow.actions.notification"),
    "the fingerprinted policy must not embed action listings",
  );

  // It must still be stable across calls, since it is a fingerprint input.
  assert.equal(policy, buildPromptPolicy());
});

test("the policy still carries the rules the model is held to", () => {
  const policy = buildPromptPolicy();
  // A policy that lost its content would hash consistently and guarantee nothing.
  for (const required of [
    "GroupingIdentifier",
    "Do not invent an identifier",
    "is.workflow.actions.conditional.otherwise",
  ]) {
    assert.ok(policy.includes(required), `policy is missing "${required}"`);
  }
});

test("scoping a prompt is measurably cheaper than sending the whole catalog", () => {
  const scoped = buildSystemPrompt({ schemas: SCOPE });

  // What the same prompt cost before scoping: policy plus the entire catalog.
  const wholeCatalog = `${buildPromptPolicy()}\n${compactCatalogForPrompt()}`;

  assert.ok(
    scoped.length < wholeCatalog.length,
    `expected the scoped prompt to be smaller (scoped ${scoped.length}, full ${wholeCatalog.length})`,
  );

  // Guard against a scoping change that quietly stops scoping. A three-action
  // request should not need most of the catalog.
  assert.ok(
    scoped.length < wholeCatalog.length * 0.75,
    `scoped prompt is only ${((scoped.length / wholeCatalog.length) * 100).toFixed(1)}% ` +
      "of the full-catalog prompt; retrieval is no longer narrowing anything meaningfully",
  );
});

test("an empty adapter cannot be minted", () => {
  // An empty adapter would make a challenger run identical to a champion run and
  // report a pass-rate delta of zero — "the candidate did not help" rather than
  // "the candidate was never applied".
  assert.throws(() => mintAdapterBlock({ text: "   ", candidateId: "cand-x" }), AdapterMintError);
  assert.throws(() => mintAdapterBlock({ text: "real text", candidateId: " " }), AdapterMintError);
});
