/**
 * The adapter boundary, expressed in the type system.
 *
 * A candidate adapter is offline training output: exemplars distilled from a
 * frozen, consented batch. It may be measured against the pipeline by a
 * benchmark, and it must never reach a live request. Previously that was a
 * convention — `adapterBlock = ""` defaulted off, and a test asserted the
 * default was honoured. A convention plus a test catches the mistake after
 * someone makes it. This module makes the mistake unrepresentable.
 *
 * `AdapterBlock` carries a brand keyed on a `unique symbol` that is declared
 * here and never exported. No other module can produce a conforming value:
 * object literals fail the brand check, and there is no constructor in this
 * file to call. The only mint is `mintAdapterBlock` in the training subtree,
 * which the request path is structurally forbidden from importing
 * (`training-isolation.test.ts` walks the import graph from `app.ts`).
 *
 * So reaching an adapter from a route requires two deliberate, visible acts: an
 * explicit `as unknown as AdapterBlock` cast, and an import that fails the
 * isolation test. Neither can happen by accident, and neither can happen
 * silently.
 *
 * This module deliberately has no imports. It is a type boundary, not a
 * dependency — which is also why the training subtree may import it without
 * gaining any path to a prompt, catalog, or model client.
 */

declare const ADAPTER_BLOCK_BRAND: unique symbol;

export interface AdapterBlock {
  /** Unforgeable outside the training subtree. Never read at runtime. */
  readonly [ADAPTER_BLOCK_BRAND]: "offline-candidate-adapter";
  /** Rendered exemplar text appended to the prompt. */
  readonly text: string;
  /** Candidate this came from, so a prompt can be traced to a decision record. */
  readonly candidateId: string;
}

/**
 * Reads adapter text for prompt assembly.
 *
 * Returns `""` for `undefined` so a caller can splice the result in without
 * branching, and so "no adapter" and "empty adapter" produce an identical
 * prompt rather than two nearly-identical ones.
 */
export function adapterText(adapter: AdapterBlock | undefined): string {
  if (!adapter) return "";
  return adapter.text;
}

/** Provenance for logs and benchmark records. `"none"` when running clean. */
export function adapterCandidateId(adapter: AdapterBlock | undefined): string {
  return adapter?.candidateId ?? "none";
}
