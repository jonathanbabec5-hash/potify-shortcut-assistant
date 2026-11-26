/**
 * Structural proof that production inference cannot reach training code.
 *
 * The requirement — "never let live conversations alter production prompts,
 * validators, catalogs, or model artifacts" — is a claim about the *import
 * graph*, not about intent. A comment saying "offline only" is not enforcement;
 * anyone can add an import tomorrow. So this test walks every module reachable
 * from `app.ts` and fails if the training subtree appears among them.
 *
 * It also checks the reverse direction: training must not import route handlers
 * or the pipeline, because that would give an offline job a live model client
 * and a path to production state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..", "..");
const TRAINING_DIR = resolve(SRC, "lib", "learning", "training");

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function resolveModule(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every .ts module reachable by following relative imports from `entry`. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveModule(match[1]!, file);
      // Test files are not part of the shipped graph.
      if (resolved && !resolved.endsWith(".test.ts")) queue.push(resolved);
    }
  }

  return seen;
}

describe("training isolation", () => {
  it("no module reachable from app.ts imports the training subtree", () => {
    const reachable = reachableFrom(resolve(SRC, "app.ts"));
    const leaked = [...reachable].filter((f) => f.startsWith(TRAINING_DIR));

    assert.deepEqual(
      leaked.map((f) => f.slice(SRC.length + 1)),
      [],
      "Training code is reachable from the request path. Production inference must not be able to reach training.",
    );
  });

  it("the request path is genuinely being walked (guards against a vacuous pass)", () => {
    const reachable = reachableFrom(resolve(SRC, "app.ts"));
    // If the walker silently resolved nothing, the test above would pass for
    // the wrong reason. Anchor on modules that must be in the graph.
    for (const expected of [
      join(SRC, "routes", "shortcuts.ts"),
      join(SRC, "lib", "shortcuts", "pipeline.ts"),
      join(SRC, "lib", "learning", "collection.ts"),
    ]) {
      assert.ok(reachable.has(expected), `expected ${expected} in the reachable graph`);
    }
  });

  it("training does not import routes or the generation pipeline", () => {
    const forbidden = [
      resolve(SRC, "routes"),
      resolve(SRC, "lib", "shortcuts", "pipeline.ts"),
      resolve(SRC, "lib", "shortcuts", "llm.ts"),
      resolve(SRC, "lib", "shortcuts", "model-config.ts"),
    ];

    for (const entry of ["batch.ts", "benchmark.ts", "candidate.ts", "loop.ts", "index.ts"]) {
      const reachable = reachableFrom(join(TRAINING_DIR, entry));
      for (const file of reachable) {
        for (const bad of forbidden) {
          assert.ok(
            !file.startsWith(bad),
            `${entry} reaches ${file.slice(SRC.length + 1)}, which belongs to the live request path`,
          );
        }
      }
    }
  });
});
