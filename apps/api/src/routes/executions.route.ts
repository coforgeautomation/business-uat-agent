import { Router } from "express";
import path from "node:path";
import { access } from "node:fs/promises";
import { createExecutionJob, getExecutionJob } from "../controllers/executionController.js";
import { ExecutionQueue } from "../workers/executionQueue.js";

export function createExecutionsRouter(queue: ExecutionQueue) {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const job = await createExecutionJob(req.body);
      queue.enqueue(job);
      return res.status(202).json({
        ...job,
        queue: { queued: queue.queuedCount, active: queue.activeCount, concurrency: queue.concurrency },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(/invalid|provide|required/i.test(message) ? 400 : 500).json({ error: message });
    }
  });

  router.get("/:executionId", async (req, res) => {
    try {
      const job = await getExecutionJob(req.params.executionId);
      return job ? res.status(200).json(job) : res.status(404).json({ error: "Execution not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/:executionId/artifacts/:artifactName", async (req, res) => {
    try {
      const job = await getExecutionJob(req.params.executionId);
      if (!job) return res.status(404).json({ error: "Execution not found" });
      const artifactName = req.params.artifactName;
      const progressArtifact = job.progress?.cases
        .map(testCase => testCase.evidence?.[artifactName])
        .find((file): file is string => Boolean(file));
      const result = typeof job.result === "object" && job.result !== null
        ? job.result as { artifacts?: Record<string, unknown>; results?: Array<{ artifacts?: Record<string, unknown> }> }
        : undefined;
      const resultArtifact = [
        result?.artifacts?.[artifactName],
        ...(result?.results ?? []).map(testCase => testCase.artifacts?.[artifactName]),
      ].find((file): file is string => typeof file === "string");
      const file = progressArtifact ?? resultArtifact;
      if (!file) return res.status(404).json({ error: "Artifact not found" });

      const automationRoot = path.resolve("output/automation");
      const absoluteFile = path.resolve(file);
      const relativeFile = path.relative(automationRoot, absoluteFile);
      if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
        return res.status(400).json({ error: "Artifact path is outside the automation output directory" });
      }
      await access(absoluteFile);
      return res.sendFile(absoluteFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ error: "Artifact file not found" });
      }
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
