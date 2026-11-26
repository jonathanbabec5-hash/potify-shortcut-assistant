/**
 * Governed continuous-learning schema.
 *
 * Five tables, in the order data moves through them:
 *
 *   consent_grants          what a subject has permitted, and until when
 *   interaction_records     the compact, redacted, provenance-carrying example
 *   run_outcomes            text-free measurements (the `outcomes-only` tier)
 *   training_batches        frozen membership for one controlled training run
 *   promotion_decisions     the gate results that did or did not promote it
 *
 * Two rules are encoded in the column set rather than left to convention:
 *
 *  1. **Every example carries the permission that allowed it.** `scope`,
 *     `policy_version`, and `consent_granted_at` are copied onto the record at
 *     write time. A later policy change or withdrawal can therefore be applied
 *     to historical rows without guessing what the subject actually agreed to.
 *
 *  2. **No column holds raw user text.** `request_redacted` is post-redaction
 *     output; the workflow is stored as an identifier signature rather than a
 *     plist; parameter *keys* are kept and parameter *values* are not.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Consent ───────────────────────────────────────────────────────────────────

/**
 * Current consent state per subject. One row per pseudonym.
 *
 * Withdrawal sets `scope` to "none" and stamps `withdrawn_at` rather than
 * deleting the row, so "this subject withdrew" stays distinguishable from
 * "this subject was never asked".
 */
export const consentGrants = pgTable(
  "consent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** privacy.pseudonymize() output. Never a raw user id, email, or device id. */
    subjectPseudonym: text("subject_pseudonym").notNull(),
    /** CollectionScope: none | outcomes-only | redacted-examples | full-examples */
    scope: text("scope").notNull(),
    policyVersion: text("policy_version").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("consent_grants_subject_idx").on(t.subjectPseudonym)],
);

// ── Interaction records ───────────────────────────────────────────────────────

export const interactionRecords = pgTable(
  "interaction_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // ── the permission this row was collected under ──
    subjectPseudonym: text("subject_pseudonym").notNull(),
    scope: text("scope").notNull(),
    policyVersion: text("policy_version").notNull(),
    consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }).notNull(),

    // ── identity and deduplication ──
    runId: text("run_id").notNull(),
    /** sha256(normalised redacted request + action signature). */
    dedupeKey: text("dedupe_key").notNull(),
    /** Incremented instead of inserting a duplicate row. */
    occurrenceCount: integer("occurrence_count").default(1).notNull(),

    // ── request (redacted) ──
    requestRedacted: text("request_redacted").notNull(),
    requestLength: integer("request_length").notNull(),
    /** PiiClass[] — classes present, never values. */
    piiClasses: jsonb("pii_classes").$type<string[]>().default([]).notNull(),

    // ── retrieved action schemas (compact) ──
    /** Array<{ identifier: string; kind: "catalog" | "external" | "unknown" }> */
    retrievedSchemas: jsonb("retrieved_schemas").$type<unknown[]>().default([]).notNull(),

    // ── generated workflow (signature, not plist) ──
    /** { actionSequence, controlFlowDepth, stepCount, variableCount, parameterKeys } */
    workflowSignature: jsonb("workflow_signature").$type<Record<string, unknown>>().notNull(),
    workflowHash: text("workflow_hash").notNull(),

    // ── history ──
    /** Array<{ stage, advisory, checklistItemId?, stepId? }> — codes, not messages. */
    validationHistory: jsonb("validation_history").$type<unknown[]>().default([]).notNull(),
    /** Array<{ attempt, resolvedStages, beforeHash, afterHash }> */
    repairHistory: jsonb("repair_history").$type<unknown[]>().default([]).notNull(),
    /** Array<{ op, index?, actionIdentifier?, parameterKey? }> — no values. */
    userEdits: jsonb("user_edits").$type<unknown[]>().default([]).notNull(),

    // ── accepted result ──
    /** Null until the user tells us. Null is NOT acceptance. */
    accepted: boolean("accepted"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Hash of what was actually accepted — may differ after user edits. */
    acceptedWorkflowHash: text("accepted_workflow_hash"),

    // ── versions ──
    targetIosVersion: text("target_ios_version"),
    minimumIosVersion: text("minimum_ios_version"),
    appVersion: text("app_version"),
    catalogVersion: text("catalog_version").notNull(),
    catalogHash: text("catalog_hash").notNull(),
    modelId: text("model_id").notNull(),
    systemPromptHash: text("system_prompt_hash").notNull(),
    validatorVersion: text("validator_version").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),

    // ── success signals ──
    /** The app offered an import. Not evidence that one happened. */
    importOffered: boolean("import_offered").default(false).notNull(),
    /** The client reported the import deep-link was actually opened. */
    importConfirmed: boolean("import_confirmed"),
    /** The user reported the shortcut ran correctly on-device. */
    deviceRunSucceeded: boolean("device_run_succeeded"),
    /** "client" | "user-report" — how the signal above was obtained. */
    successSignalSource: text("success_signal_source"),

    // ── measurement and screening ──
    outcome: text("outcome").notNull(),
    qualityScore: real("quality_score").notNull(),
    /** "active" | "quarantined" | "rejected" */
    status: text("status").notNull(),
    quarantineReasons: jsonb("quarantine_reasons").$type<string[]>().default([]).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("interaction_records_dedupe_idx").on(t.dedupeKey),
    index("interaction_records_subject_idx").on(t.subjectPseudonym),
    index("interaction_records_status_idx").on(t.status),
    index("interaction_records_run_idx").on(t.runId),
  ],
);

// ── Outcomes (text-free tier) ─────────────────────────────────────────────────

export const runOutcomes = pgTable(
  "run_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectPseudonym: text("subject_pseudonym").notNull(),
    runId: text("run_id").notNull(),

    /**
     * Which kind of run this measures. Repair runs share the table because the
     * governed fields are identical, but they must stay distinguishable —
     * mixing them would silently corrupt success rates and failure clusters.
     */
    kind: text("kind").notNull().default("generate"),

    outcome: text("outcome").notNull(),
    importOffered: boolean("import_offered").default(false).notNull(),
    executableActionCount: integer("executable_action_count").default(0).notNull(),
    checklistItemCount: integer("checklist_item_count").default(0).notNull(),
    unsatisfiedItemCount: integer("unsatisfied_item_count").default(0).notNull(),
    hardErrorStages: jsonb("hard_error_stages").$type<string[]>().default([]).notNull(),
    advisoryErrorCount: integer("advisory_error_count").default(0).notNull(),
    warningCount: integer("warning_count").default(0).notNull(),
    uncertaintyCount: integer("uncertainty_count").default(0).notNull(),

    descriptionLength: integer("description_length").default(0).notNull(),
    redactedClasses: jsonb("redacted_classes").$type<string[]>().default([]).notNull(),
    containedSecret: boolean("contained_secret").default(false).notNull(),

    durationMs: integer("duration_ms").default(0).notNull(),
    totalTokens: integer("total_tokens").default(0).notNull(),
    costByStage: jsonb("cost_by_stage").$type<unknown[]>().default([]).notNull(),

    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    errorKind: text("error_kind"),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("run_outcomes_run_idx").on(t.runId),
    index("run_outcomes_measured_idx").on(t.measuredAt),
    index("run_outcomes_kind_idx").on(t.kind),
  ],
);

// ── Controlled batch training ─────────────────────────────────────────────────

/**
 * One frozen training batch. Membership is fixed at freeze time and recorded in
 * `training_batch_members`; `manifest_hash` covers the member set, so a batch
 * that was trained on cannot later be edited without detection.
 */
export const trainingBatches = pgTable("training_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  /** "frozen" | "trained" | "discarded" */
  status: text("status").notNull(),
  memberCount: integer("member_count").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  minQualityScore: real("min_quality_score").notNull(),
  /** The exact selection criteria, so the batch is reproducible. */
  selection: jsonb("selection").$type<Record<string, unknown>>().notNull(),
  /** Eval set and production artifacts as of freeze time. */
  evalSetFingerprint: text("eval_set_fingerprint").notNull(),
  artifactFingerprint: jsonb("artifact_fingerprint").$type<Record<string, unknown>>().notNull(),
  frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const trainingBatchMembers = pgTable(
  "training_batch_members",
  {
    batchId: uuid("batch_id").notNull(),
    recordId: uuid("record_id").notNull(),
    /** Content hash of the record at freeze time. */
    contentHash: text("content_hash").notNull(),
    qualityScore: real("quality_score").notNull(),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.recordId] })],
);

// ── Promotion ─────────────────────────────────────────────────────────────────

export const promotionDecisions = pgTable(
  "promotion_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: text("candidate_id").notNull(),
    championId: text("champion_id").notNull(),
    batchId: uuid("batch_id"),

    approved: boolean("approved").notNull(),
    /** Every GateResult, including the ones that blocked. */
    gateResults: jsonb("gate_results").$type<unknown[]>().default([]).notNull(),
    failedGates: jsonb("failed_gates").$type<string[]>().default([]).notNull(),
    missingGates: jsonb("missing_gates").$type<string[]>().default([]).notNull(),
    conflictedGates: jsonb("conflicted_gates").$type<string[]>().default([]).notNull(),

    benchmark: jsonb("benchmark").$type<Record<string, unknown>>(),
    rollbackPlan: jsonb("rollback_plan").$type<Record<string, unknown>>(),
    /** Who approved. Required by the human-approval gate. */
    approvedBy: text("approved_by"),
    summary: text("summary").notNull(),

    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("promotion_decisions_candidate_idx").on(t.candidateId)],
);

// ── Candidates ────────────────────────────────────────────────────────────────

/**
 * A produced candidate adapter.
 *
 * Persisted so that "versioning" and "rollback" refer to a real, retrievable
 * artifact. A rollback plan that names a version nothing stored is a promise,
 * not a mechanism.
 */
export const trainingCandidates = pgTable(
  "training_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Content-addressed id — same inputs, same candidate. */
    candidateId: text("candidate_id").notNull().unique(),
    version: text("version").notNull(),
    parentChampionId: text("parent_champion_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    strategy: text("strategy").notNull(),
    contentHash: text("content_hash").notNull(),

    exemplarCount: integer("exemplar_count").notNull(),
    estimatedPromptTokens: integer("estimated_prompt_tokens").notNull(),

    /** The full adapter, so a reviewer can read what it learned. */
    adapter: jsonb("adapter").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    /** Why batch members did not become exemplars. */
    exclusions: jsonb("exclusions").$type<Record<string, unknown>>().notNull(),

    /** "candidate" | "champion" | "retired" — only a human sets champion. */
    status: text("status").notNull().default("candidate"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("training_candidates_batch_idx").on(t.batchId),
    index("training_candidates_status_idx").on(t.status),
  ],
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConsentGrantRow = typeof consentGrants.$inferSelect;
export type TrainingCandidateRow = typeof trainingCandidates.$inferSelect;
export type InteractionRecordRow = typeof interactionRecords.$inferSelect;
export type InsertInteractionRecord = typeof interactionRecords.$inferInsert;
export type RunOutcomeRow = typeof runOutcomes.$inferSelect;
export type TrainingBatchRow = typeof trainingBatches.$inferSelect;
export type PromotionDecisionRow = typeof promotionDecisions.$inferSelect;
