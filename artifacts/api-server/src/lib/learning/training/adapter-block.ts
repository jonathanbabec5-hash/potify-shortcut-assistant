/**
 * The only mint for an `AdapterBlock`.
 *
 * ⚠️  Offline only. Nothing in the request path may import this module — that is
 * enforced by `training-isolation.test.ts`, which walks the import graph from
 * `app.ts` and fails if the training subtree appears in it.
 *
 * ## Why the mint lives here and not next to the type
 *
 * `lib/shortcuts/adapter.ts` declares `AdapterBlock` with a brand keyed on an
 * unexported `unique symbol`, so the type cannot be satisfied by an object
 * literal anywhere. Someone still has to be able to create one, and wherever
 * that constructor lives becomes the real boundary. Putting it in the training
 * subtree means the boundary is the same import-graph rule that already governs
 * every other piece of training code, rather than a second, weaker rule that
 * would need its own enforcement.
 *
 * The single cast below is the entire trusted surface. It is one line, in a file
 * the request path cannot reach, and it is the only place in the codebase where
 * an adapter comes into existence.
 */

import type { AdapterBlock } from "../../shortcuts/adapter";

export class AdapterMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterMintError";
  }
}

/**
 * Wraps rendered exemplar text as an `AdapterBlock`.
 *
 * Refuses empty text. An empty adapter is not a harmless no-op here: it would
 * make a challenger benchmark identical to the champion's and report a
 * pass-rate delta of zero, which reads as "the candidate did not help" rather
 * than "the candidate was never applied". Those two must not look the same.
 */
export function mintAdapterBlock(input: {
  text: string;
  candidateId: string;
}): AdapterBlock {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new AdapterMintError(
      "Refusing to mint an empty adapter block: a benchmark run against it would be " +
        "indistinguishable from a champion run and would silently report no effect.",
    );
  }
  if (input.candidateId.trim().length === 0) {
    throw new AdapterMintError(
      "An adapter block requires a candidate id so a prompt can be traced back to a decision record.",
    );
  }

  return { text, candidateId: input.candidateId.trim() } as unknown as AdapterBlock;
}
