/**
 * The signals that only exist *after* a run: repairs, user edits, whether the
 * shortcut ran on the device, and what the user finally settled on.
 *
 * These were the fields that sat permanently empty, so switching them on is
 * exactly the moment to prove they are governed like everything else. Each test
 * here asserts one of the three properties the collection layer promises:
 *
 *   1. Nothing is written without a grant that covers it, and a repair
 *      transcript sits at the same bar as a user correction.
 *   2. Nothing free-text reaches storage from a repair.
 *   3. Collecting changes no production artifact — not the catalog, not the
 *      system prompt, not the validators.
 *
 * They run against the real database on unique random subjects, purged after.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db, interactionRecords } from "@workspace/db";
import {
  attachFeedback,
  authorizeCollection,
  purgeSubject,
  recordInteraction,
  saveConsent,
} from "./collection";
import { collectRepair } from "./collect-repair";
import { ConsentError } from "./consent";
import { pseudonymize } from "./privacy";
import { RUN_PROVENANCE, verifyArtifactIntegrity } from "./boot";
import { measureRepair } from "./outcomes";
import {
  isIssuedRunId,
  repairEventFrom,
  sanitizeBuildIdentifier,
  sanitizeUserEdits,
} from "./records";
import type { InteractionDraft, RepairEvent } from "./records";
import type { ShortcutPlist } from "../shortcuts/catalog";
import { getActionByIdentifier } from "../shortcuts/catalog";

const subjects: string[] = [];

function freshSubject(): string {
  const subject = pseudonymize(`test-${randomUUID()}`);
  subjects.push(subject);
  return subject;
}

after(async () => {
  for (const subject of subjects) await purgeSubject(subject);
});

/**
 * Records are deduplicated on (redacted request, action sequence), so every
 * seeded example needs a distinct request or the second one is silently
 * dropped and the test that depends on it fails for the wrong reason.
 */
let seedSeq = 0;
function uniqueWord(): string {
  const alpha = "abcdefghijklmnopqrstuvwxyz";
  let n = (seedSeq += 1);
  let word = "";
  while (n > 0) {
    word += alpha[(n - 1) % 26];
    n = Math.floor((n - 1) / 26);
  }
  return word;
}

function draftFor(runId: string, overrides: Partial<InteractionDraft> = {}): InteractionDraft {
  return {
    runId,
    request: `Turn on the ${uniqueWord()} porch light when I get home after sunset`,
    retrievedSchemas: [
      { identifier: "is.workflow.actions.conditional", kind: "catalog" },
    ],
    workflow: {
      actionSequence: ["is.workflow.actions.conditional", "is.workflow.actions.notification"],
      controlFlowDepth: 1,
      stepCount: 1,
      variableCount: 0,
      parameterKeys: ["WFControlFlowMode"],
    },
    validation: [],
    repairs: [],
    edits: [],
    accepted: null,
    acceptedWorkflowHash: null,
    signals: { importOffered: true, importConfirmed: null, deviceRunSucceeded: null, source: null },
    versions: { targetIosVersion: "17.0", minimumIosVersion: "17.0", appVersion: "1.0.0" },
    provenance: RUN_PROVENANCE,
    outcome: "ready",
    uncertaintyCount: 0,
    ...overrides,
  };
}

const BEFORE: ShortcutPlist = {
  WFWorkflowActions: [
    { WFWorkflowActionIdentifier: "is.workflow.actions.gettext", WFWorkflowActionParameters: {} },
  ],
};

const AFTER: ShortcutPlist = {
  WFWorkflowActions: [
    { WFWorkflowActionIdentifier: "is.workflow.actions.gettext", WFWorkflowActionParameters: {} },
    { WFWorkflowActionIdentifier: "is.workflow.actions.notification", WFWorkflowActionParameters: {} },
  ],
};

function repairEvent(): RepairEvent {
  return repairEventFrom({
    attempt: 1,
    before: BEFORE,
    after: AFTER,
    requestedSources: ["schema"],
    requestedCount: 2,
    unresolvedCount: 0,
    changeCount: 1,
  });
}

function repairOutcome(runId: string) {
  return measureRepair({
    runId,
    startedAt: 1_000,
    finishedAt: 2_000,
    repairedActionCount: 2,
    requestedCount: 2,
    unresolvedCount: 0,
    provenance: RUN_PROVENANCE,
  });
}

/** Creates a stored example owned by `subject` and returns its run id. */
async function seedRecord(subject: string): Promise<string> {
  const runId = randomUUID();
  const permit = await authorizeCollection(subject, "redacted-examples");
  const stored = await recordInteraction(permit, draftFor(runId));
  assert.equal(
    stored.stored,
    true,
    `seed must actually store (refused: ${stored.refusedBecause ?? "none"}, deduped: ${stored.deduplicated ?? false})`,
  );
  return runId;
}

async function rowFor(subject: string, runId: string) {
  const [row] = await db
    .select()
    .from(interactionRecords)
    .where(
      and(
        eq(interactionRecords.runId, runId),
        eq(interactionRecords.subjectPseudonym, subject),
      ),
    )
    .limit(1);
  return row;
}

// ── Consent gates repair collection exactly as it gates generation ────────────

describe("repair collection is consent-gated", () => {
  it("stores nothing for a subject who has never granted anything", async () => {
    const subject = freshSubject();
    const report = await collectRepair({
      subject,
      runId: randomUUID(),
      repair: repairEvent(),
      outcome: repairOutcome(randomUUID()),
    });

    assert.deepEqual(report, { outcomeStored: false, repairAttached: false });
  });

  it("stores nothing when the client sent no subject at all", async () => {
    const report = await collectRepair({
      subject: null,
      runId: randomUUID(),
      repair: repairEvent(),
      outcome: repairOutcome(randomUUID()),
    });

    assert.deepEqual(report, { outcomeStored: false, repairAttached: false });
  });

  it("records the outcome but withholds the transcript at outcomes-only", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "outcomes-only");

    const report = await collectRepair({
      subject,
      runId: randomUUID(),
      repair: repairEvent(),
      outcome: repairOutcome(randomUUID()),
    });

    assert.equal(report.outcomeStored, true, "a measured repair is text-free");
    assert.equal(report.repairAttached, false, "a transcript is a correction");
  });

  it("still withholds the transcript at redacted-examples", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "redacted-examples");
    const runId = await seedRecord(subject);

    const report = await collectRepair({
      subject,
      runId,
      repair: repairEvent(),
      outcome: repairOutcome(runId),
    });

    assert.equal(report.repairAttached, false);
    const row = await rowFor(subject, runId);
    assert.deepEqual(row?.repairHistory ?? [], [], "nothing was written");
  });

  it("records both once the grant covers corrections", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);

    const report = await collectRepair({
      subject,
      runId,
      repair: repairEvent(),
      outcome: repairOutcome(runId),
    });

    assert.equal(report.outcomeStored, true);
    assert.equal(report.repairAttached, true);

    const row = await rowFor(subject, runId);
    assert.equal(row?.repairHistory?.length, 1, "the repair is on the parent example");
  });

  it("records the outcome of a repair that has no example to attach to", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");

    // A shortcut the user pasted in rather than generated here.
    const report = await collectRepair({
      subject,
      runId: null,
      repair: repairEvent(),
      outcome: repairOutcome(randomUUID()),
    });

    assert.equal(report.outcomeStored, true);
    assert.equal(report.repairAttached, false);
  });

  it("never throws, whatever it is handed", async () => {
    const report = await collectRepair({
      subject: "not-a-real-pseudonym",
      runId: randomUUID(),
      repair: repairEvent(),
      outcome: repairOutcome(randomUUID()),
    });

    assert.equal(report.repairAttached, false);
  });
});

// ── A guessed run id reaches nothing ──────────────────────────────────────────

describe("attachment is scoped to the caller's own subject", () => {
  it("will not attach a repair to an example owned by someone else", async () => {
    const victim = freshSubject();
    await saveConsent(victim, "full-examples");
    const runId = await seedRecord(victim);

    const attacker = freshSubject();
    await saveConsent(attacker, "full-examples");

    const report = await collectRepair({
      subject: attacker,
      runId, // known, guessed, or leaked — it makes no difference
      repair: repairEvent(),
      outcome: repairOutcome(runId),
    });

    assert.equal(report.repairAttached, false);

    const row = await rowFor(victim, runId);
    assert.deepEqual(row?.repairHistory ?? [], [], "the victim's record is untouched");
  });
});

// ── The transcript is structurally incapable of carrying prose ────────────────

describe("a repair transcript carries no free text", () => {
  it("keeps every value the user could have written out of the event", () => {
    const secret = "Remind Dr. Sofia at sofia@example.com about 555-0100";
    const before: ShortcutPlist = {
      WFWorkflowActions: [
        {
          WFWorkflowActionIdentifier: "is.workflow.actions.notification",
          WFWorkflowActionParameters: { WFNotificationActionBody: secret },
        },
      ],
    };
    const after: ShortcutPlist = {
      WFWorkflowActions: [
        {
          WFWorkflowActionIdentifier: "is.workflow.actions.notification",
          WFWorkflowActionParameters: { WFNotificationActionBody: `${secret} tomorrow` },
        },
      ],
    };

    const event = repairEventFrom({
      attempt: 1,
      before,
      after,
      requestedSources: ["ai", "schema", "ai"],
      requestedCount: 1,
      unresolvedCount: 0,
      changeCount: 1,
    });

    const serialized = JSON.stringify(event);
    for (const fragment of ["Sofia", "sofia@example.com", "555-0100", "tomorrow"]) {
      assert.ok(!serialized.includes(fragment), `leaked: ${fragment}`);
    }

    // Nothing but numbers, booleans, hashes, and a closed enum of sources.
    assert.deepEqual(event.requestedSources, ["ai", "schema"], "deduped and sorted");
    for (const [key, value] of Object.entries(event)) {
      if (key === "requestedSources") continue;
      assert.ok(
        typeof value === "number" || typeof value === "boolean" || typeof value === "string",
        `${key} must be a scalar`,
      );
    }
    assert.match(event.beforeHash, /^[0-9a-f]+$/, "a hash, not content");
    assert.match(event.afterHash, /^[0-9a-f]+$/);

    // The two shortcuts differ only in what the notification says, and the
    // hashes are equal — which is the point. The signature covers shape and
    // parameter *keys*, so no amount of hashing can carry the user's prose.
    assert.equal(event.beforeHash, event.afterHash, "value-only edits are invisible to the hash");
  });

  it("still exposes a structural change", () => {
    const event = repairEvent();
    assert.notEqual(
      event.beforeHash,
      event.afterHash,
      "adding an action changes the shape, and that must be visible",
    );
  });

  it("reports an honest verdict when the repair threw", () => {
    const event = repairEventFrom({
      attempt: 2,
      before: BEFORE,
      after: null,
      requestedSources: ["completion"],
      requestedCount: 3,
      unresolvedCount: 0, // the engine never got far enough to claim this
      changeCount: 7,
    });

    assert.equal(event.succeeded, false);
    assert.equal(event.unresolvedCount, 3, "a throw resolves nothing");
    assert.equal(event.resolvedCount, 0);
    assert.equal(event.changeCount, 0, "no changes survive a throw");
    assert.equal(event.afterHash, event.beforeHash);
  });
});

// ── Edits and acceptance ──────────────────────────────────────────────────────

describe("user edits require a corrections grant", () => {
  it("refuses edits at redacted-examples", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "redacted-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "redacted-examples");

    await assert.rejects(
      () =>
        attachFeedback(permit, {
          runId,
          edits: [{ op: "remove-action", index: 0 }],
        }),
      ConsentError,
    );

    const row = await rowFor(subject, runId);
    assert.deepEqual(row?.userEdits ?? [], []);
  });

  it("stores edits once the grant covers them", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "full-examples");

    const result = await attachFeedback(permit, {
      runId,
      edits: [
        { op: "remove-action", index: 1, actionIdentifier: "is.workflow.actions.notification" },
        { op: "reorder-action", index: 0 },
      ],
    });

    assert.equal(result.updated, true);
    const row = await rowFor(subject, runId);
    assert.equal(row?.userEdits?.length, 2);
  });
});

describe("acceptance is recorded as provenance", () => {
  it("stamps acceptedAt and the workflow hash on the transition to accepted", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "full-examples");

    const before = await rowFor(subject, runId);
    assert.equal(before?.acceptedAt ?? null, null, "not accepted until it is");

    await attachFeedback(permit, {
      runId,
      accepted: true,
      deviceRunSucceeded: true,
      acceptedWorkflowHash: "deadbeef",
    });

    const row = await rowFor(subject, runId);
    assert.equal(row?.accepted, true);
    assert.equal(row?.acceptedWorkflowHash, "deadbeef");
    assert.ok(row?.acceptedAt, "acceptedAt must be stamped");
  });

  it("does not move acceptedAt when the user confirms again", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "full-examples");

    await attachFeedback(permit, { runId, accepted: true }, 1_000_000);
    const first = (await rowFor(subject, runId))?.acceptedAt;

    await attachFeedback(permit, { runId, accepted: true }, 9_000_000);
    const second = (await rowFor(subject, runId))?.acceptedAt;

    assert.deepEqual(second, first, "acceptedAt is provenance, not a touch column");
  });
});

// ── Collection is inert with respect to production behaviour ──────────────────

describe("collecting changes no production artifact", () => {
  it("leaves the catalog, system prompt, and validators byte-identical", async () => {
    const before = verifyArtifactIntegrity();
    assert.equal(before.ok, true, "precondition: the process booted clean");

    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "full-examples");

    await collectRepair({
      subject,
      runId,
      repair: repairEvent(),
      outcome: repairOutcome(runId),
    });
    await attachFeedback(permit, {
      runId,
      accepted: true,
      deviceRunSucceeded: true,
      edits: [{ op: "add-action", index: 2, actionIdentifier: "is.workflow.actions.comment" }],
    });

    const after = verifyArtifactIntegrity();
    assert.equal(after.ok, true, "collection must not disturb production artifacts");
    assert.equal(after.boot.catalogHash, before.boot.catalogHash);
    assert.equal(after.boot.systemPromptHash, before.boot.systemPromptHash);
    assert.equal(after.boot.catalogVersion, before.boot.catalogVersion);
    assert.deepEqual(after.artifacts.drifted, [], "no artifact drifted");
  });
});

// ── Edit events cannot be used to smuggle text into storage ───────────────────

/**
 * `/learning/feedback` is unauthenticated, so the two string fields on a
 * UserEditEvent arrive as arbitrary text regardless of what this app's client
 * sends. They are checked against the catalog rather than against a shape, so
 * prose has nowhere to hide — including dotted or camel-jammed prose, which a
 * regex or a length cap would happily accept.
 */
describe("user edit events are reduced to closed sets", () => {
  const KNOWN_ACTION = "is.workflow.actions.notification";
  const entry = getActionByIdentifier(KNOWN_ACTION);
  const knownParam =
    [...(entry?.parameters.required ?? []), ...(entry?.parameters.optional ?? [])][0]?.key;

  it("precondition: the fixture action and parameter really are in the catalog", () => {
    assert.ok(entry, `${KNOWN_ACTION} must exist for this suite to mean anything`);
    assert.ok(knownParam, "the fixture action must declare at least one parameter");
  });

  it("keeps a genuine identifier and a genuine parameter key", () => {
    const [event] = sanitizeUserEdits([
      { op: "edit-parameter", index: 3, actionIdentifier: KNOWN_ACTION, parameterKey: knownParam },
    ]);

    assert.deepEqual(event, {
      op: "edit-parameter",
      index: 3,
      actionIdentifier: KNOWN_ACTION,
      parameterKey: knownParam,
    });
  });

  it("drops prose in actionIdentifier but keeps the structural signal", () => {
    const [event] = sanitizeUserEdits([
      {
        op: "remove-action",
        index: 2,
        actionIdentifier: "Call Dr. Sofia on 555-0100 about the biopsy results",
      },
    ]);

    assert.deepEqual(event, { op: "remove-action", index: 2 });
  });

  it("drops dotted prose, which a shape check would have accepted", () => {
    const [event] = sanitizeUserEdits([
      { op: "add-action", actionIdentifier: "Call.Dr.Sofia.About.The.Biopsy.Results" },
    ]);

    assert.deepEqual(event, { op: "add-action" });
  });

  it("drops a parameter key the action does not declare", () => {
    const [event] = sanitizeUserEdits([
      {
        op: "edit-parameter",
        actionIdentifier: KNOWN_ACTION,
        parameterKey: "sofia_at_example_dot_com",
      },
    ]);

    assert.deepEqual(event, { op: "edit-parameter", actionIdentifier: KNOWN_ACTION });
  });

  it("drops a parameter key entirely when there is no action to check it against", () => {
    const [event] = sanitizeUserEdits([
      { op: "edit-parameter", parameterKey: knownParam },
    ]);

    assert.deepEqual(event, { op: "edit-parameter" }, "no action means no closed set");
  });

  it("discards events with an op it does not recognise", () => {
    const clean = sanitizeUserEdits([
      { op: "exfiltrate" as never, actionIdentifier: KNOWN_ACTION },
      { op: "add-action" },
    ]);

    assert.equal(clean.length, 1);
    assert.equal(clean[0]?.op, "add-action");
  });

  it("discards an index that is not a plausible position", () => {
    const clean = sanitizeUserEdits([
      { op: "add-action", index: -1 },
      { op: "add-action", index: 1.5 },
      { op: "add-action", index: 10_000 },
      { op: "add-action", index: Number.NaN },
    ]);

    assert.equal(clean.length, 4, "the events survive");
    for (const event of clean) {
      assert.equal(event.index, undefined, "but the bogus index does not");
    }
  });

  it("caps how many events one submission can add", () => {
    const many = Array.from({ length: 500 }, () => ({ op: "add-action" as const }));
    assert.equal(sanitizeUserEdits(many).length, 200);
  });

  it("tolerates junk instead of an array", () => {
    assert.deepEqual(sanitizeUserEdits(null), []);
    assert.deepEqual(sanitizeUserEdits(undefined), []);
    assert.deepEqual(sanitizeUserEdits([null as never, 42 as never]), []);
  });

  it("never lets prose reach the database, even with full consent", async () => {
    const subject = freshSubject();
    await saveConsent(subject, "full-examples");
    const runId = await seedRecord(subject);
    const permit = await authorizeCollection(subject, "full-examples");

    const secrets = ["Sofia", "sofia@example.com", "555-0100", "sk-live-abcdef"];
    await attachFeedback(permit, {
      runId,
      edits: [
        {
          op: "edit-parameter",
          index: 0,
          actionIdentifier: `Remind Sofia at sofia@example.com`,
          parameterKey: "555-0100",
        },
        {
          op: "add-action",
          actionIdentifier: KNOWN_ACTION,
          parameterKey: "sk-live-abcdef",
        },
      ],
    });

    const row = await rowFor(subject, runId);
    const serialized = JSON.stringify(row?.userEdits ?? []);
    for (const secret of secrets) {
      assert.ok(!serialized.includes(secret), `leaked into user_edits: ${secret}`);
    }
    assert.equal(row?.userEdits?.length, 2, "the structural signal is still kept");
  });
});

// ── The other two client-supplied strings that get persisted ──────────────────

describe("identifiers accepted from a client are checked before they are stored", () => {
  it("treats anything that is not a server-issued id as no id at all", () => {
    assert.equal(isIssuedRunId(randomUUID()), true);
    assert.equal(isIssuedRunId(randomUUID().toUpperCase()), true);

    for (const bogus of [
      "Remind Sofia at sofia@example.com",
      "../../etc/passwd",
      "",
      "not-a-uuid",
      // Right length, wrong alphabet — a length check alone would pass this.
      "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(isIssuedRunId(bogus), false, `accepted: ${String(bogus)}`);
    }
  });

  it("keeps a real build identifier", () => {
    assert.equal(sanitizeBuildIdentifier("0.0.0+m3k1x9"), "0.0.0+m3k1x9");
    assert.equal(sanitizeBuildIdentifier("1.2.3"), "1.2.3");
    assert.equal(sanitizeBuildIdentifier("  2.0.0-beta.1  "), "2.0.0-beta.1", "trimmed");
  });

  it("refuses anything a sentence could hide in", () => {
    for (const bogus of [
      "Remind Sofia at sofia@example.com",
      "version one point two",
      "a".repeat(65),
      "-leading-punctuation",
      "has\nnewline",
      "",
      "   ",
      null,
      undefined,
    ]) {
      assert.equal(
        sanitizeBuildIdentifier(bogus as string),
        null,
        `accepted: ${String(bogus)}`,
      );
    }
  });
});
