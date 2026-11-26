import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { verifyArtifactIntegrity } from "../lib/learning/boot";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Reports whether the catalog, system prompt, validator, and evaluation set
 * still match what this process booted with.
 *
 * Kept separate from /healthz so the health contract stays untouched, and so a
 * governance failure is loud (500) rather than a field nobody reads.
 */
router.get("/integrity", (_req, res) => {
  const report = verifyArtifactIntegrity();
  res.status(report.ok ? 200 : 500).json(report);
});

export default router;
