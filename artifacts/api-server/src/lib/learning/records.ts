/**
 * The compact interaction record.
 *
 * This module defines what one training example *is* and how it is derived from
 * a pipeline run. Two constraints shape every decision here:
 *
 *  1. **Compact.** A stored example must stay small enough that millions of them
 *     remain cheap to scan, cluster, and select from. So the workflow is stored
 *     as an identifier signature, not a plist; validation history as stage codes,
 *     not messages; parameters as keys, not values.
 *
 *  2. **No raw user content, ever.** The only free text is `request`, and the
 *     writer redacts it before it reaches the database. Parameter *values* are
 *     the other obvious leak — a "send message" action carries the message body
 *     — so they are dropped entirely and only the keys are kept.
 *
 * Dropping parameter values costs real signal. It is still the right trade:
 * the identifier sequence and parameter *shape* are what the model gets wrong,
 * and they are learnable without knowing that the message said "running late".
 */

import { createHash } from "node:crypto";
import type { ShortcutPlist } from "../shortcuts/catalog";
import { getActionByIdentifier } from "../shortcuts/catalog";
import type {
  IRValidationStage,
  PipelineResult,
} from "../shortcuts/pipeline-types";
import type { RunOutcomeKind, RunProvenance } from "./outcomes";

// ── Component types ───────────────────────────────────────────────────────────

export interface RetrievedSchemaRef {
  identifier: string;
  kind: "catalog" | "external" | "unknown";
}

export interface WorkflowSignature {
  /** Action identifiers in execution order, including control-flow markers. */
  actionSequence: string[];
  /** Max control-flow nesting depth. */
  controlFlowDepth: number;
  /** Non-control-flow actions. */
  stepCount: number;
  variableCount: number;
  /** Sorted unique parameter keys. Keys only — never values. */
  parameterKeys: string[];
}

export interface ValidationEvent {
  stage: IRValidationStage;
  advisory: boolean;
  checklistItemId?: string;
  stepId?: string;
}

/**
 * One repair pass, recorded as counts and hashes only.
 *
 * Deliberately carries no free text. The repair engine's changelog describes
 * changes in prose assembled from action names and parameter values, which is
 * exactly the kind of field that quietly becomes a text store — so the shape of
 * the repair is kept and the narration is discarded.
 *
 * Every field here is derivable from what the repair call already produced, so
 * none of them can sit permanently empty.
 */
export interface RepairEvent {
  attempt: number;
  /** Distinct validation sources the repair was asked to address. */
  requestedSources: ValidationSource[];
  /** Blocking findings going in, and how many the engine could not resolve. */
  requestedCount: number;
  unresolvedCount: number;
  resolvedCount: number;
  /** Structural changes the repair actually made. */
  changeCount: number;
  beforeHash: string;
  afterHash: string;
  /** False when the repair threw rather than returning a shortcut. */
  succeeded: boolean;
}

export type ValidationSource = "schema" | "ai" | "completion" | "pipeline";

export type UserEditOp =
  | "add-action"
  | "remove-action"
  | "reorder-action"
  | "replace-action"
  | "edit-parameter";

export interface UserEditEvent {
  op: UserEditOp;
  index?: number;
  actionIdentifier?: string;
  /** Key only. The value the user typed is never recorded. */
  parameterKey?: string;
}

const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a caller-supplied run id could be one this server issued.
 *
 * A run id sent by a client is stored verbatim as an identifier, so if it is
 * accepted unchecked it becomes another way to write arbitrary text into the
 * database. Every id this server hands out is a UUID, so anything else is not a
 * run — and treating it as absent costs a legitimate caller nothing.
 */
export function isIssuedRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_RE.test(value);
}

/** No build identifier is longer than this, and none contains prose. */
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Reduces a client-declared build identifier to something that is plausibly one.
 *
 * `appVersion` is provenance — it exists to tell two builds apart — but it
 * arrives as an arbitrary string on an unauthenticated endpoint and is stored
 * as given. The shape below admits versions, hashes, and build suffixes while
 * excluding whitespace, so a sentence cannot be parked in it. Unlike an action
 * identifier there is no closed set to check against, so shape and length are
 * the strongest honest check available.
 *
 * Returns null rather than a truncated value: a half-stored build id is worse
 * than none, because it still looks like provenance.
 */
export function sanitizeBuildIdentifier(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return BUILD_ID_RE.test(trimmed) ? trimmed : null;
}

const USER_EDIT_OPS: ReadonlySet<string> = new Set<UserEditOp>([
  "add-action",
  "remove-action",
  "reorder-action",
  "replace-action",
  "edit-parameter",
]);

/**
 * No real editing session produces more events than this, and an unbounded
 * array is a storage-exhaustion vector on an unauthenticated endpoint.
 */
const MAX_USER_EDITS = 200;

/** Action lists this long do not exist; past it, an "index" is not an index. */
const MAX_ACTION_INDEX = 999;

/**
 * Reduces client-submitted edits to values drawn from closed, server-controlled
 * sets.
 *
 * The feedback endpoint is unauthenticated, so `actionIdentifier` and
 * `parameterKey` arrive as arbitrary strings no matter what this app's own
 * client sends. Stored as-is they would be a way to write free text — and so
 * PII — into the record, which is the exact thing this layer exists to prevent.
 * A length cap or a shape regex does not close it either: dotted or
 * camel-jammed prose fits through both.
 *
 * So neither string is trusted as content. An identifier survives only if the
 * catalog already knows it, and a parameter key only if it belongs to that
 * action's own schema — and what gets stored is the catalog's copy of the
 * string, not the caller's. Anything else is dropped while the surrounding
 * event, whose op and position carry the actual learning signal, is kept.
 *
 * Pure, and deliberately lossy in the safe direction.
 */
export function sanitizeUserEdits(
  input: readonly UserEditEvent[] | null | undefined,
): UserEditEvent[] {
  if (!Array.isArray(input)) return [];

  const clean: UserEditEvent[] = [];

  for (const raw of input.slice(0, MAX_USER_EDITS)) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.op !== "string" || !USER_EDIT_OPS.has(raw.op)) continue;

    const event: UserEditEvent = { op: raw.op };

    if (
      typeof raw.index === "number" &&
      Number.isInteger(raw.index) &&
      raw.index >= 0 &&
      raw.index <= MAX_ACTION_INDEX
    ) {
      event.index = raw.index;
    }

    const entry =
      typeof raw.actionIdentifier === "string"
        ? getActionByIdentifier(raw.actionIdentifier)
        : undefined;
    if (entry) event.actionIdentifier = entry.identifier;

    // Only checkable against a known action. With no action there is no closed
    // set to check against, so the key is dropped rather than guessed at.
    if (entry && typeof raw.parameterKey === "string") {
      const known = [
        ...entry.parameters.required,
        ...entry.parameters.optional,
      ].find((p) => p.key === raw.parameterKey);
      if (known) event.parameterKey = known.key;
    }

    clean.push(event);
  }

  return clean;
}

export interface SuccessSignals {
  /** The app offered an import. NOT evidence that one happened. */
  importOffered: boolean;
  /** The client reported the import deep-link was opened. */
  importConfirmed?: boolean | null;
  /** The user reported the shortcut actually ran correctly on-device. */
  deviceRunSucceeded?: boolean | null;
  source?: "client" | "user-report" | null;
}

export interface VersionInfo {
  targetIosVersion?: string | null;
  minimumIosVersion?: string | null;
  appVersion?: string | null;
}

/**
 * A run, reduced to what is worth keeping. `request` is still raw at this point
 * — `collection.recordInteraction` redacts it and refuses the write if any
 * unredacted content survives.
 */
export interface InteractionDraft {
  runId: string;
  request: string;
  retrievedSchemas: RetrievedSchemaRef[];
  workflow: WorkflowSignature;
  validation: ValidationEvent[];
  repairs: RepairEvent[];
  edits: UserEditEvent[];
  accepted?: boolean | null;
  acceptedWorkflowHash?: string | null;
  signals: SuccessSignals;
  versions: VersionInfo;
  provenance: RunProvenance;
  outcome: RunOutcomeKind;
  uncertaintyCount: number;
}

// ── Derivation ────────────────────────────────────────────────────────────────

/** Control-flow actions carry WFControlFlowMode: 0 opens, 1 branches, 2 closes. */
function controlFlowMode(params: Record<string, unknown> | undefined): number | null {
  const mode = params?.["WFControlFlowMode"];
  return typeof mode === "number" ? mode : null;
}

export function workflowSignatureOf(plist: ShortcutPlist): WorkflowSignature {
  const actions = plist.WFWorkflowActions ?? [];
  const actionSequence: string[] = [];
  const parameterKeys = new Set<string>();

  let depth = 0;
  let maxDepth = 0;
  let stepCount = 0;

  for (const action of actions) {
    const identifier = action.WFWorkflowActionIdentifier;
    actionSequence.push(identifier);

    const params = action.WFWorkflowActionParameters as
      | Record<string, unknown>
      | undefined;
    for (const key of Object.keys(params ?? {})) parameterKeys.add(key);

    const mode = controlFlowMode(params);
    if (mode === 0) {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    } else if (mode === 2) {
      depth = Math.max(0, depth - 1);
    } else if (mode === null) {
      stepCount += 1;
    }
  }

  // Variables are referenced through parameter values we deliberately do not
  // store, so count the actions that declare an output name instead.
  const variableCount = actions.filter((a) => {
    const params = a.WFWorkflowActionParameters as Record<string, unknown> | undefined;
    return typeof params?.["CustomOutputName"] === "string";
  }).length;

  return {
    actionSequence,
    controlFlowDepth: maxDepth,
    stepCount,
    variableCount,
    parameterKeys: [...parameterKeys].sort(),
  };
}

export function hashWorkflowSignature(sig: WorkflowSignature): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        a: sig.actionSequence,
        d: sig.controlFlowDepth,
        p: sig.parameterKeys,
      }),
    )
    .digest("hex");
}

/**
 * Validation events, stripped to codes.
 *
 * Messages are excluded on purpose: they are assembled from action identifiers
 * and user-derived values, so they are exactly the kind of field that quietly
 * becomes a text store. Stage plus the two generated ids is enough to cluster
 * failures, which is all this history is for.
 */
export function validationEventsOf(result: PipelineResult): ValidationEvent[] {
  const events: ValidationEvent[] = [];
  for (const e of result.hardIrErrors ?? []) {
    events.push({
      stage: e.stage,
      advisory: false,
      ...(e.checklistItemId ? { checklistItemId: e.checklistItemId } : {}),
      ...(e.stepId ? { stepId: e.stepId } : {}),
    });
  }
  for (const e of result.advisoryIrErrors ?? []) {
    events.push({
      stage: e.stage,
      advisory: true,
      ...(e.checklistItemId ? { checklistItemId: e.checklistItemId } : {}),
      ...(e.stepId ? { stepId: e.stepId } : {}),
    });
  }
  return events;
}

/**
 * Which action identifiers the run actually depended on, and whether each was
 * grounded in the catalog. `unknown` entries are the interesting ones — they
 * are what Stage 4 hard-fails on and the strongest signal for catalog work.
 */
export function retrievedSchemaRefs(
  result: PipelineResult,
  catalogHas: (identifier: string) => boolean,
): RetrievedSchemaRef[] {
  const required = new Set<string>();
  for (const item of result.checklist ?? []) {
    for (const id of item.requiredActions ?? []) required.add(id);
  }

  const groundingFailures = new Set(
    (result.hardIrErrors ?? [])
      .filter((e) => e.stage === "grounding")
      .map((e) => e.stepId)
      .filter((v): v is string => typeof v === "string"),
  );

  return [...required].sort().map((identifier) => ({
    identifier,
    kind: catalogHas(identifier)
      ? ("catalog" as const)
      : groundingFailures.has(identifier)
        ? ("unknown" as const)
        : ("external" as const),
  }));
}

/**
 * Builds the repair record from a finished repair call.
 *
 * Pure, and derives its verdict from what the engine returned rather than from
 * a caller-supplied flag — the same rule `measureRun` follows, for the same
 * reason: a buggy route must not be able to record a failed repair as a good
 * one.
 */
export function repairEventFrom(input: {
  attempt: number;
  before: ShortcutPlist;
  after?: ShortcutPlist | null;
  requestedSources: readonly ValidationSource[];
  requestedCount: number;
  unresolvedCount: number;
  changeCount: number;
}): RepairEvent {
  const succeeded = Boolean(input.after);
  const unresolved = succeeded ? input.unresolvedCount : input.requestedCount;
  const beforeHash = hashWorkflowSignature(workflowSignatureOf(input.before));

  return {
    attempt: input.attempt,
    requestedSources: [...new Set(input.requestedSources)].sort(),
    requestedCount: input.requestedCount,
    unresolvedCount: unresolved,
    resolvedCount: Math.max(0, input.requestedCount - unresolved),
    changeCount: succeeded ? input.changeCount : 0,
    beforeHash,
    afterHash: input.after
      ? hashWorkflowSignature(workflowSignatureOf(input.after))
      : beforeHash,
    succeeded,
  };
}

export function draftFromRun(input: {
  runId: string;
  request: string;
  result: PipelineResult;
  outcome: RunOutcomeKind;
  provenance: RunProvenance;
  targetIosVersion?: string | null;
  appVersion?: string | null;
  catalogHas: (identifier: string) => boolean;
}): InteractionDraft {
  const workflow = workflowSignatureOf(input.result.shortcut);
  return {
    runId: input.runId,
    request: input.request,
    retrievedSchemas: retrievedSchemaRefs(input.result, input.catalogHas),
    workflow,
    validation: validationEventsOf(input.result),
    repairs: [],
    edits: [],
    accepted: null,
    acceptedWorkflowHash: null,
    signals: {
      // Mirrors the route's own import gate: satisfied completion, checklist
      // met, AND a stored file. Anything weaker is not an offer.
      importOffered: Boolean(
        input.result.completionStatus?.satisfied === true &&
          input.result.checklistSatisfied &&
          input.result.id,
      ),
      importConfirmed: null,
      deviceRunSucceeded: null,
      source: null,
    },
    versions: {
      targetIosVersion: input.targetIosVersion ?? null,
      minimumIosVersion: input.result.minimumIosVersion ?? null,
      appVersion: input.appVersion ?? null,
    },
    provenance: input.provenance,
    outcome: input.outcome,
    uncertaintyCount: input.result.uncertainty?.length ?? 0,
  };
}
