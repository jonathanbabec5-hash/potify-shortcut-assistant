import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  GenerateShortcutBody,
  ValidateShortcutBody,
  ExplainShortcutBody,
  RepairShortcutBody,
  SuggestNextActionsBody,
  StoreShortcutFileBody,
  GetShortcutFileParams,
  ClarifyShortcutBody,
  PlanShortcutBody,
  DiagnoseShortcutBody,
} from "@workspace/api-zod";
import { getCatalogSummary } from "../lib/shortcuts/catalog";
import { encodeShortcutToPlist } from "../lib/shortcuts/plist";
import { storeShortcut, getStoredShortcut } from "../lib/shortcuts/store";
import { validateShortcut, diffShortcuts } from "../lib/shortcuts/validation";
import {
  explainShortcut,
  repairShortcut,
  suggestNextActions,
  semanticValidation,
} from "../lib/shortcuts/llm";
import { runPipeline } from "../lib/shortcuts/pipeline";
import { buildClarificationRequest, buildPlan, planToShortcut } from "../lib/shortcuts/planner";
import { analyzeDataFlow } from "../lib/shortcuts/dataflow";
import { analyzeCompatibility } from "../lib/shortcuts/compatibility";
import { CostCeilingError, CostLedger, withCostLedger } from "../lib/learning/cost";
import { RUN_PROVENANCE } from "../lib/learning/boot";
import { measureRepair, measureRun, type RunErrorKind } from "../lib/learning/outcomes";
import { redact } from "../lib/learning/privacy";
import { collectRun, subjectPseudonymFrom } from "../lib/learning/collect-run";
import { collectRepair } from "../lib/learning/collect-repair";
import { isIssuedRunId, repairEventFrom, type ValidationSource } from "../lib/learning/records";
import type {
  GenerateShortcutResponse,
  ValidateShortcutResponse,
  ExplainShortcutResponse,
  RepairShortcutResponse,
  SuggestNextActionsResponse,
  StoreShortcutFileResponse,
  ClarifyShortcutResponse,
  PlanShortcutResponse,
  DiagnoseShortcutResponse,
} from "../lib/shortcuts/types";

const router: IRouter = Router();

router.get("/shortcuts/actions", async (_req, res): Promise<void> => {
  res.json(getCatalogSummary());
});

router.post("/shortcuts/clarify", async (req, res): Promise<void> => {
  const parsed = ClarifyShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = buildClarificationRequest(
      parsed.data.description,
      parsed.data.targetIosVersion,
    );
    const response: ClarifyShortcutResponse = {
      needed: result.needed,
      questions: result.questions,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to clarify shortcut");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/plan", async (req, res): Promise<void> => {
  const parsed = PlanShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const plan = buildPlan(
      parsed.data.description,
      (parsed.data.slots as Record<string, unknown>) ?? {},
      parsed.data.targetIosVersion,
    );
    const response: PlanShortcutResponse = plan;
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to plan shortcut");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/diagnose", async (req, res): Promise<void> => {
  const parsed = DiagnoseShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const dataFlow = analyzeDataFlow(parsed.data.shortcut);
    const compatibility = analyzeCompatibility(parsed.data.shortcut, parsed.data.targetIosVersion);
    const trace = validateShortcut(parsed.data.shortcut, parsed.data.targetIosVersion).executionTrace;

    const response: DiagnoseShortcutResponse = {
      trace,
      producedVariables: dataFlow.producedVariables.length,
      consumedVariables: dataFlow.consumedVariables.length,
      unboundInputs: dataFlow.unboundInputs.length,
      unreachableSteps: dataFlow.unreachableSteps,
      requiredDeviceFeatures: compatibility.requiredDeviceFeatures,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to diagnose shortcut");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/generate", async (req, res): Promise<void> => {
  const parsed = GenerateShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // ── Measurement ────────────────────────────────────────────────────────────
  // measureRun is pure and derives the outcome from what the pipeline actually
  // returned, so it runs unconditionally — computing an outcome is not
  // collecting one. Nothing is retained here: retention requires consent.
  // Only the PII *classes* and a length are taken from the description; the
  // text itself never reaches the outcome record or the log.
  const runId = randomUUID();
  const startedAt = Date.now();
  const ledger = new CostLedger();
  const description = parsed.data.description;
  const subject = subjectPseudonymFrom(parsed.data.subject);
  const scan = redact(description);
  const shape = {
    descriptionLength: description.length,
    redactedClasses: scan.classes,
    containedSecret: scan.containsSecret,
  };

  try {
    // ── Six-stage reasoning pipeline ─────────────────────────────────────────
    // Replaces the old single-LLM generateShortcut call with a deterministic
    // pipeline: Stage 1 locks an intent checklist before any plist is generated;
    // Stages 2-6 verify that every item is satisfied before returning success.
    const result = await withCostLedger(ledger, () =>
      runPipeline(
        description,
        parsed.data.targetIosVersion,
        (parsed.data.slots as Record<string, unknown>) ?? {},
      ),
    );

    const outcome = measureRun({
      runId,
      startedAt,
      finishedAt: Date.now(),
      result,
      cost: ledger.summary(),
      provenance: RUN_PROVENANCE,
      ...shape,
    });
    req.log.info({ outcome }, "Shortcut run outcome");

    // Retention, as opposed to measurement. collectRun performs its own consent
    // lookup and stores nothing without a matching grant; it never throws, so a
    // collection failure cannot turn a successful generation into an error.
    req.log.info(
      {
        collection: await collectRun({
          subject,
          outcome,
          description,
          result,
          targetIosVersion: parsed.data.targetIosVersion ?? null,
          appVersion: parsed.data.appVersion ?? null,
        }),
      },
      "Collection result",
    );

    // Return 422 only for hard grounding errors (Stage 4, stage === "grounding").
    // These mean the LLM invented action identifiers not in the catalog — the
    // shortcut cannot be represented as a valid plist. Detection is keyed on
    // the structured IRValidationError.stage field, never on message text.
    // Completion failures (unsupported, incomplete, placeholder) always return
    // 200 so the frontend can display the appropriate failure card.
    const groundingErrors = result.hardIrErrors.filter(
      (e) => e.stage === "grounding",
    );
    if (groundingErrors.length > 0) {
      res.status(422).json({
        error: "Generated shortcut references actions that are not in the Shortcuts catalog.",
        findings: groundingErrors.map((e) => ({ message: e.message, suggestion: e.suggestion })),
      });
      return;
    }

    const response: GenerateShortcutResponse = {
      // Echoed so the client can attach later signals — import confirmed, ran
      // on device, user edits — to this exact example.
      runId,
      ...(result.id !== undefined ? { id: result.id } : {}),
      shortcut: result.shortcut,
      actions: result.actions,
      warnings: result.warnings,
      minimumIosVersion: result.minimumIosVersion,
      explanation: result.explanation,
      uncertainty: result.uncertainty,
      alternatives: result.alternatives,
      completionStatus: result.completionStatus,
      checklistSatisfied: result.checklistSatisfied,
      checklist: result.checklist,
    };

    res.json(response);
  } catch (err) {
    const overBudget = err instanceof CostCeilingError;
    // An SDK error carries an HTTP status; anything with one came from the
    // provider, not from our own code. Keeping these apart matters because a
    // run of provider failures says nothing about pipeline quality and must
    // not be read as a regression.
    const fromProvider = typeof (err as { status?: unknown })?.status === "number";
    const outcome = measureRun({
      runId,
      startedAt,
      finishedAt: Date.now(),
      result: null,
      errorKind: overBudget ? "cost-ceiling" : fromProvider ? "provider" : "internal",
      cost: ledger.summary(),
      provenance: RUN_PROVENANCE,
      ...shape,
    });
    req.log.error({ err, outcome }, "Failed to generate shortcut");

    // Failures are the examples most worth having. There is no result to build
    // an example from, so only the text-free outcome tier applies here.
    await collectRun({ subject, outcome, description, result: null });
    res.status(overBudget ? 429 : 500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/validate", async (req, res): Promise<void> => {
  const parsed = ValidateShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const schemaValidation = validateShortcut(
      parsed.data.shortcut,
      parsed.data.targetIosVersion,
    );
    const aiFindings = await semanticValidation(parsed.data.shortcut);

    const response: ValidateShortcutResponse = {
      findings: [...schemaValidation.findings, ...aiFindings],
      minimumIosVersion: schemaValidation.minimumIosVersion,
      requiredPermissions: schemaValidation.requiredPermissions,
      requiredDeviceFeatures: schemaValidation.requiredDeviceFeatures,
      dataFlowSummary: schemaValidation.dataFlowSummary,
      executionTrace: schemaValidation.executionTrace,
    };

    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to validate shortcut");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/explain", async (req, res): Promise<void> => {
  const parsed = ExplainShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await explainShortcut(parsed.data.shortcut);
    const response: ExplainShortcutResponse = {
      steps: result.steps,
      summary: result.summary,
      dataFlow: result.dataFlow,
      compatibility: result.compatibility,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to explain shortcut");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/repair", async (req, res): Promise<void> => {
  const parsed = RepairShortcutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // A repair is a learning example in exactly the way a generation is: it shows
  // what the generator got wrong and what fixed it. Measured and collected on
  // both the success and the failure path — a repair engine that quietly stops
  // resolving things is only visible in the failures.
  const startedAt = Date.now();
  // The claimed run id is stored verbatim as an identifier, so it is only
  // trusted when it has the shape of one this server issues. Anything else is
  // treated as absent — the repair is still measured, just not linked.
  const linkedRunId = isIssuedRunId(parsed.data.runId) ? parsed.data.runId : null;
  const runId = linkedRunId ?? randomUUID();
  const subject = subjectPseudonymFrom(parsed.data.subject);
  const before = parsed.data.shortcut;
  const blocking = parsed.data.findings.filter((f) => f.severity !== "info");
  const requestedSources = blocking.map((f) => f.source as ValidationSource);

  const collect = async (
    after: typeof before | null,
    unresolvedCount: number,
    changeCount: number,
    errorKind: RunErrorKind | null,
  ): Promise<void> => {
    const report = await collectRepair({
      subject,
      runId: linkedRunId,
      repair: repairEventFrom({
        attempt: 1,
        before,
        after,
        requestedSources,
        requestedCount: blocking.length,
        unresolvedCount,
        changeCount,
      }),
      outcome: measureRepair({
        runId,
        startedAt,
        finishedAt: Date.now(),
        repairedActionCount: after ? (after.WFWorkflowActions?.length ?? 0) : null,
        requestedCount: blocking.length,
        unresolvedCount,
        errorKind,
        provenance: RUN_PROVENANCE,
      }),
    });
    req.log.info({ collection: report }, "Repair collection result");
  };

  try {
    const result = await repairShortcut(parsed.data.shortcut, parsed.data.findings, parsed.data.targetIosVersion);
    const changes = diffShortcuts(parsed.data.shortcut, result.shortcut);

    await collect(result.shortcut, result.unresolved.length, changes.length, null);

    const response: RepairShortcutResponse = {
      shortcut: result.shortcut,
      changelog: changes.length > 0 ? changes : result.changelog,
      unresolved: result.unresolved,
      alternatives: result.alternatives,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to repair shortcut");
    await collect(null, blocking.length, 0, "provider");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/suggest", async (req, res): Promise<void> => {
  const parsed = SuggestNextActionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await suggestNextActions(
      parsed.data.actions,
      parsed.data.context,
    );
    const response: SuggestNextActionsResponse = {
      suggestions: result.suggestions,
    };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to suggest next actions");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/shortcuts/file", async (req, res): Promise<void> => {
  const parsed = StoreShortcutFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const id = storeShortcut(parsed.data.shortcut);
    const response: StoreShortcutFileResponse = { id };
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to store shortcut file");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/shortcuts/file/:id", async (req, res): Promise<void> => {
  // Gate #1 note: This endpoint hosts an unsigned binary plist .shortcut file.
  // It is used as the `shortcuts://import-shortcut?url=` target only if Gate #1
  // proves that iOS 15+/26 accepts unsigned files via the URL scheme. If Gate #1
  // fails, the frontend falls back to file download (Path D) and the visual
  // construction guide (Path E), both of which remain valid regardless of the
  // URL-scheme outcome. The endpoint is built now so it can be tested in Gate #1.
  const params = GetShortcutFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const shortcut = getStoredShortcut(params.data.id);
  if (!shortcut) {
    res.status(404).json({ error: "Shortcut file not found or expired" });
    return;
  }

  const name = (shortcut.WFWorkflowName || "shortcut").replace(/\s+/g, "_");
  const buffer = encodeShortcutToPlist(shortcut);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${name}.shortcut"`,
  );
  res.send(buffer);
});

export default router;
