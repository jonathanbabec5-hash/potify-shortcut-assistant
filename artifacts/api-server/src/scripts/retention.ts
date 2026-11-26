/**
 * Offline retention sweep.
 *
 *   pnpm --filter @workspace/api-server run retention              # dry run
 *   pnpm --filter @workspace/api-server run retention -- --execute  # delete
 *
 * Run by hand. There is deliberately no scheduler, no cron entry, and no
 * in-process timer: this deployment is autoscale with ephemeral containers, so a
 * timer would either fan out across replicas or never fire at all depending on
 * traffic. Deletion of user data should be an act someone performed, and can say
 * when they performed.
 *
 * Never imported by the server — the same rule the training subtree follows.
 */

import { parseArgs } from "node:util";

import { describeSweep, executeRetentionSweep, planRetentionSweep } from "../lib/learning/retention";

const { values } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    /** Evaluate the schedule as of a different instant. Testing aid. */
    "as-of": { type: "string" },
  },
  strict: true,
});

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let now = Date.now();
  if (values["as-of"]) {
    const parsed = Date.parse(values["as-of"]);
    if (!Number.isFinite(parsed)) die(`--as-of must be a parseable date, got "${values["as-of"]}".`);
    now = parsed;
  }

  // Always show the plan first, even when executing. An operator about to delete
  // user data should see the counts and the frozen-batch consequence in the same
  // output as the deletion, not have to reconstruct them afterwards.
  const plan = await planRetentionSweep(now);
  console.log(`\n▸ Retention plan as of ${new Date(now).toISOString()}`);
  for (const cls of plan.classes) {
    console.log(`\n  ${cls.id} — ${cls.count} row(s)`);
    console.log(`    ${cls.rationale}`);
  }

  if (!values.execute) {
    console.log(
      `\n${describeSweep({ ...plan, dryRun: true, deleted: { "records-consent-expired": 0, "records-policy-superseded": 0, "outcomes-aged-out": 0, "grants-expired-and-unused": 0 } })}\n`,
    );
    console.log("  Nothing was deleted. Re-run with --execute to apply.\n");
    process.exit(0);
  }

  const result = await executeRetentionSweep({ now, dryRun: false });
  console.log(`\n${describeSweep(result)}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`\n  ✗ Retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
