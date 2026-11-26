import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiTsPath = path.resolve(__dirname, "..", "..", "api-zod", "src", "generated", "api.ts");

const content = await readFile(apiTsPath, "utf-8");

// Orval v8.22.0 targets zod 4, but the workspace is on zod 3.x. Each patch below
// rewrites a zod 4 top-level API into its zod 3 equivalent. If codegen starts
// failing typecheck with "Property 'x' does not exist on type 'typeof zod'",
// that is a new zod 4 API to add here.
const patches = [
  // zod 4 has looseObject for free-form objects; zod 3 has no equivalent, so
  // fall back to a generic record.
  [/zod\.looseObject\(\s*\{\s*\}\s*\)/g, "zod.record(zod.string(), zod.any())"],
  // zod 4 promoted string formats to the top level: z.uuid() etc.
  [/zod\.uuid\(\)/g, "zod.string().uuid()"],
  [/zod\.email\(\)/g, "zod.string().email()"],
  [/zod\.url\(\)/g, "zod.string().url()"],
  [/zod\.datetime\(\)/g, "zod.string().datetime()"],
];

let fixed = content;
const applied = [];
for (const [pattern, replacement] of patches) {
  const before = fixed;
  fixed = fixed.replace(pattern, replacement);
  if (fixed !== before) applied.push(String(pattern));
}

await writeFile(apiTsPath, fixed, "utf-8");
console.log(
  applied.length
    ? `Patched zod 4 syntax in generated schemas: ${applied.join(", ")}`
    : "No zod 4 syntax to patch in generated schemas.",
);
