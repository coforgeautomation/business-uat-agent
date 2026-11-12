import { Router } from "express";
import { findReusableGeneratedTest } from "../../../../packages/orchestration/src/generatedTestReuse.js";
import { casesForStory, findStory, readApprovedPlan } from "../../../../packages/orchestration/src/planReader.js";
import {
  createAutomationGenerationBatch,
  getAutomationGenerationBatch,
  listAutomationGenerationBatches,
  updateAutomationGenerationBatch,
  type AutomationGenerationBatch,
} from "../controllers/automationGenerationController.js";
import {
  getExecutionCheckpoint,
  getScriptMetadata,
} from "../../../../packages/playwright/services/automationRepository.js";
import { createExecutionJob, getExecutionJob, listExecutionJobs, saveExecutionJob } from "../controllers/executionController.js";
import { ExecutionQueue } from "../workers/executionQueue.js";

export function createScriptsRouter(queue: ExecutionQueue) {
  const router = Router();

  router.get("/stories/:storyId/test-cases", async (req, res) => {
    try {
      const { story } = await approvedStory(req.params.storyId);
      const storyJobs = (await listExecutionJobs()).filter(job => job.storyId === story.id);
      const testCases = await Promise.all(casesForStory(story).map(async testCase => {
        const [script, metadata, checkpoint] = await Promise.all([
          findReusableGeneratedTest(story.id, testCase),
          getScriptMetadata(story.id, testCase.id),
          getExecutionCheckpoint(story.id, testCase.id),
        ]);
        const scriptAvailable = script !== undefined && "file" in script;
        const history = storyJobs.flatMap(job => {
          const result = resultForCase(job, testCase.id);
          if (!result && job.testCaseId !== testCase.id) return [];
          return [{
            executionId: job.executionId,
            status: result?.status ?? job.status,
            createdAt: job.startedAt ?? job.createdAt,
            finishedAt: job.finishedAt,
            error: result?.error ?? job.error,
            evidence: stringRecord(result?.artifacts),
            testSource: typeof result?.testSource === "string" ? result.testSource : undefined,
          }];
        });
        const latestRun = history[0];
        const automationStatus = metadata?.status === "NEEDS_HEALING" ? "Needs Healing"
          : metadata?.status === "BLOCKED" || checkpoint?.status === "BLOCKED" ? "Blocked"
            : scriptAvailable ? "Ready to Execute" : "Needs Automation";
        return {
          testCaseId: testCase.id,
          title: testCase.title,
          reviewStatus: testCase.reviewStatus,
          objective: testCase.objective,
          type: testCase.type,
          priority: testCase.priority,
          acceptanceCriteriaIds: testCase.acceptanceCriteriaIds,
          preconditions: testCase.preconditions,
          steps: testCase.steps,
          expectedOutcome: testCase.expectedOutcome,
          testData: testCase.test_data,
          automationFeasibility: testCase.automationFeasibility,
          automationReason: testCase.automationReason,
          automationStatus,
          lifecycleStatus: metadata?.status ?? (scriptAvailable ? "GENERATED" : "NOT_GENERATED"),
          scriptAvailable,
          lastExecutionAt: latestRun?.finishedAt ?? latestRun?.createdAt ?? metadata?.lastExecutionAt ?? checkpoint?.endedAt,
          lastResult: latestRun?.status ?? checkpoint?.status,
          lastExecutionId: latestRun?.executionId ?? checkpoint?.executionId,
          lastPassedStep: checkpoint?.lastPassedStep ?? metadata?.lastPassedStep ?? 0,
          lastExecutedStep: checkpoint?.lastExecutedStep ?? 0,
          history,
          scriptVersion: metadata?.version ?? (scriptAvailable ? 1 : 0),
          lastHealingAt: metadata?.lastHealingAt,
        };
      }));
      const totals = {
        testCases: testCases.length,
        scriptsGenerated: testCases.filter(testCase => testCase.scriptAvailable).length,
        passed: testCases.filter(testCase => testCase.lastResult === "passed" || testCase.lastResult === "PASSED").length,
        failed: testCases.filter(testCase => testCase.lastResult === "failed" || testCase.lastResult === "FAILED").length,
        blocked: testCases.filter(testCase => testCase.lastResult === "blocked" || testCase.lastResult === "BLOCKED").length,
        needsAutomation: testCases.filter(testCase => !testCase.scriptAvailable).length,
        needsHealing: testCases.filter(testCase => testCase.automationStatus === "Needs Healing").length,
        readyToExecute: testCases.filter(testCase => testCase.scriptAvailable && testCase.automationStatus === "Ready to Execute").length,
        lastExecutionAt: testCases
          .map(testCase => testCase.lastExecutionAt)
          .filter((timestamp): timestamp is string => Boolean(timestamp))
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0],
      };
      return res.json({
        storyId: story.id,
        storyTitle: story.title,
        storyDescription: story.description,
        automationCoverage: testCases.length ? Math.round((totals.scriptsGenerated / testCases.length) * 100) : 0,
        totals,
        testCases,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/stories/:storyId/test-cases/:testCaseId/execute", async (req, res) => {
    try {
      const { story, testCase } = await approvedTestCase(req.params.storyId, req.params.testCaseId);
      const job = await queueCase(queue, story.id, testCase.id);
      return res.status(202).json(job);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/stories/:storyId/test-cases/:testCaseId/scripts/generate", async (req, res) => {
    try {
      const { story, testCase } = await approvedTestCase(req.params.storyId, req.params.testCaseId);
      const existing = await findReusableGeneratedTest(story.id, testCase);
      if (existing && "file" in existing) return res.json({ skipped: true, reason: "Automation already exists" });
      const job = await queueCase(queue, story.id, testCase.id);
      return res.status(202).json({ skipped: false, ...job });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/stories/:storyId/test-cases/:testCaseId/scripts/regenerate", async (req, res) => {
    try {
      const { story, testCase } = await approvedTestCase(req.params.storyId, req.params.testCaseId);
      const job = await queueCase(queue, story.id, testCase.id, true);
      return res.status(202).json(job);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/stories/:storyId/scripts/generate-all", async (req, res) => {
    try {
      const { story } = await approvedStory(req.params.storyId);
      const cases = await Promise.all(casesForStory(story).map(async testCase => ({
        testCase,
        existing: await findReusableGeneratedTest(story.id, testCase),
        metadata: await getScriptMetadata(story.id ?? "unassigned-story", testCase.id),
      })));
      const validated = (item: typeof cases[number]) => Boolean(
        item.existing && "file" in item.existing
        && (item.metadata?.status === "PASSED" || item.metadata?.status === "HEALED"),
      );
      const missing = cases.filter(item => !validated(item));
      const batch = await createAutomationGenerationBatch(story.id, cases.map(item => ({
        testCaseId: item.testCase.id,
        title: item.testCase.title,
        initialStage: validated(item) ? "completed" : "queued",
        confidence: item.testCase.confidence,
      })));
      if (missing.length) {
        void runAutomationGenerationBatch(batch.batchId, queue).catch(error => {
          console.error(`Automation generation batch ${batch.batchId} failed:`, error);
        });
      } else {
        await updateAutomationGenerationBatch(batch.batchId, current => {
          current.status = "completed";
          current.finishedAt = new Date().toISOString();
        });
      }
      return res.status(202).json({
        storyId: story.id,
        total: cases.length,
        skipped: cases.filter(validated).length,
        queued: missing.length,
        batchId: batch.batchId,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/stories/:storyId/generation-batches/:batchId", async (req, res) => {
    try {
      const { story } = await approvedStory(req.params.storyId);
      const batch = await getAutomationGenerationBatch(req.params.batchId);
      if (!batch || batch.storyId !== story.id) {
        return res.status(404).json({ error: "Automation generation batch not found" });
      }
      const cases = await Promise.all(batch.cases.map(async item => {
        const job = item.executionId ? await getExecutionJob(item.executionId) : undefined;
        const attemptIds = item.executionIds ?? (item.executionId ? [item.executionId] : []);
        const attemptJobs = await Promise.all(attemptIds.map(getExecutionJob));
        const progress = job?.progress?.currentCase;
        const stage = item.failureReason ? "failed"
          : job?.status === "passed" ? "completed"
            : job?.status === "failed" ? "failed"
              : job?.status === "blocked" ? "blocked"
                : progress?.stage ?? item.initialStage ?? "queued";
        const resultError = typeof job?.result === "object" && job.result !== null && "error" in job.result
          && typeof job.result.error === "string" ? job.result.error : undefined;
        return {
          testCaseId: item.testCaseId,
          title: item.title,
          executionId: item.executionId,
          stage,
          currentAction: progress?.currentAction,
          currentUrl: progress?.currentUrl,
          locatorsFound: progress?.locatorsFound ?? 0,
          confidence: progress?.confidence ?? item.confidence,
          failureReason: item.failureReason ?? progress?.errorReason ?? job?.error ?? resultError,
          logs: attemptJobs.flatMap(attempt => attempt?.progress?.observation ?? [])
            .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
        };
      }));
      const completed = cases.filter(item => item.stage === "completed").length;
      const failed = cases.filter(item => item.stage === "failed").length;
      const blocked = cases.filter(item => item.stage === "blocked").length;
      const inProgress = cases.filter(item =>
        !["queued", "completed", "failed", "blocked"].includes(item.stage),
      ).length;
      const currentCase = cases.find(item =>
        !["queued", "completed", "failed", "blocked"].includes(item.stage),
      );
      return res.json({
        ...batch,
        totals: {
          total: cases.length,
          completed,
          inProgress,
          failed,
          blocked,
          remaining: cases.length - completed - inProgress - failed - blocked,
        },
        currentCase,
        cases,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/stories/:storyId/generation-batches/:batchId/resume", async (req, res) => {
    try {
      const { story } = await approvedStory(req.params.storyId);
      const batch = await getAutomationGenerationBatch(req.params.batchId);
      if (!batch || batch.storyId !== story.id) {
        return res.status(404).json({ error: "Automation generation batch not found" });
      }
      if (batch.status !== "paused") {
        return res.status(409).json({ error: `Cannot resume a ${batch.status} automation generation batch` });
      }
      await updateAutomationGenerationBatch(batch.batchId, current => {
        current.status = "running";
      });
      void runAutomationGenerationBatch(batch.batchId, queue, true).catch(error => {
        console.error(`Could not resume automation generation batch ${batch.batchId}:`, error);
      });
      return res.status(202).json({ batchId: batch.batchId, status: "running" });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/stories/:storyId/generation-batches", async (req, res) => {
    try {
      const { story } = await approvedStory(req.params.storyId);
      const batch = (await listAutomationGenerationBatches())
        .filter(item => item.storyId === story.id && item.status !== "completed")
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      return batch
        ? res.json({ batchId: batch.batchId, status: batch.status })
        : res.status(404).json({ error: "No active automation generation batch" });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export async function pausePendingAutomationGenerationBatches() {
  const active = (await listAutomationGenerationBatches()).filter(batch => batch.status !== "completed");
  for (const batch of active) {
    await updateAutomationGenerationBatch(batch.batchId, current => {
      current.status = "paused";
    });
  }
}

async function runAutomationGenerationBatch(batchId: string, queue: ExecutionQueue, resume = false) {
  await updateAutomationGenerationBatch(batchId, batch => {
    batch.status = "running";
    batch.startedAt ??= new Date().toISOString();
  });
  const initial = await getAutomationGenerationBatch(batchId);
  if (!initial) throw new Error(`Automation generation batch disappeared: ${batchId}`);

  for (const item of initial.cases) {
    if (item.initialStage === "completed" && !item.executionId) continue;
    try {
      let job = item.executionId ? await getExecutionJob(item.executionId) : undefined;
      let recoveryAttempted = false;
      if (job && ["passed", "failed", "blocked"].includes(job.status)) {
        if (canRecoverGeneratedReplay(job) && (item.executionIds?.length ?? 0) < 2) {
          recoveryAttempted = true;
          job = undefined;
        } else {
          continue;
        }
      }
      if (job && job.status !== "queued") {
        if (resume && queue.isKnown(job.executionId)) {
          const completedJob = await queue.enqueueAndWait(job);
          if (canRecoverGeneratedReplay(completedJob) && !recoveryAttempted) {
            await enqueueMcpRecoveryAttempt(batchId, initial.storyId, item, completedJob, queue);
          }
          continue;
        }
        if (!resume) throw new Error(`Execution ${job.executionId} is already ${job.status}`);
        const failureReason = `API restarted while the test case was ${job.progress?.currentCase?.stage ?? job.status}; retrying this case from Planning.`;
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = failureReason;
        await saveExecutionJob(job);
        job = undefined;
      }
      if (!job) {
        job = await createExecutionJob({
          storyId: initial.storyId,
          testCaseId: item.testCaseId,
        });
        await updateAutomationGenerationBatch(batchId, batch => {
          const current = batch.cases.find(testCase => testCase.testCaseId === item.testCaseId);
          if (current) {
            current.executionIds ??= current.executionId ? [current.executionId] : [];
            current.executionId = job!.executionId;
            current.executionIds = [...(current.executionIds ?? []), job!.executionId];
            current.failureReason = undefined;
          }
        });
      } else {
        await updateAutomationGenerationBatch(batchId, batch => {
          const current = batch.cases.find(testCase => testCase.testCaseId === item.testCaseId);
          if (current) {
            current.executionIds ??= [job!.executionId];
            current.executionId = job!.executionId;
            current.failureReason = undefined;
          }
        });
      }
      const completedJob = await queue.enqueueAndWait(job);
      if (canRecoverGeneratedReplay(completedJob) && !recoveryAttempted) {
        await enqueueMcpRecoveryAttempt(batchId, initial.storyId, item, completedJob, queue);
      }
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      console.error(`Automation generation failed for ${item.testCaseId} in batch ${batchId}:`, failureReason);
      await updateAutomationGenerationBatch(batchId, batch => {
        const current = batch.cases.find(testCase => testCase.testCaseId === item.testCaseId);
        if (current) current.failureReason = failureReason;
      });
    }
  }

  await updateAutomationGenerationBatch(batchId, batch => {
    batch.status = "completed";
    batch.finishedAt = new Date().toISOString();
  });
}

function canRecoverGeneratedReplay(job: NonNullable<Awaited<ReturnType<typeof getExecutionJob>>>): boolean {
  if (job.status !== "blocked" || typeof job.result !== "object" || job.result === null) return false;
  const result = job.result as Record<string, unknown>;
  const failureText = `${job.error ?? ""} ${typeof result.error === "string" ? result.error : ""}`;
  if (/\b(?:EPERM|EACCES|EBUSY)\b/.test(failureText) && /rename/i.test(failureText)) return true;
  if (typeof result.generatedTest !== "string" || typeof result.replay !== "object" || result.replay === null) return false;
  const replay = result.replay as Record<string, unknown>;
  return replay.status === "blocked"
    && replay.failureType === "automation"
    && typeof replay.failedStepId === "string";
}

async function enqueueMcpRecoveryAttempt(
  batchId: string,
  storyId: string,
  item: AutomationGenerationBatch["cases"][number],
  failedJob: NonNullable<Awaited<ReturnType<typeof getExecutionJob>>>,
  queue: ExecutionQueue,
) {
  const recoveryJob = await createExecutionJob({
    storyId,
    testCaseId: item.testCaseId,
  });
  await updateAutomationGenerationBatch(batchId, batch => {
    const current = batch.cases.find(testCase => testCase.testCaseId === item.testCaseId);
    if (current) {
      current.executionIds ??= [failedJob.executionId];
      current.executionIds.push(recoveryJob.executionId);
      current.executionId = recoveryJob.executionId;
      current.failureReason = undefined;
    }
  });
  return queue.enqueueAndWait(recoveryJob);
}

function resultForCase(job: Awaited<ReturnType<typeof listExecutionJobs>>[number], testCaseId: string) {
  const result = job.result;
  if (typeof result !== "object" || result === null) return undefined;
  if ("testCaseId" in result && result.testCaseId === testCaseId) return result as Record<string, unknown>;
  if ("results" in result && Array.isArray(result.results)) {
    const match = result.results.find(item =>
      typeof item === "object" && item !== null && "testCaseId" in item && item.testCaseId === testCaseId,
    );
    return typeof match === "object" && match !== null ? match as Record<string, unknown> : undefined;
  }
  if (job.testCaseId === testCaseId) return result as Record<string, unknown>;
  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function approvedStory(storyId: string) {
  const plan = await readApprovedPlan("output/sprint-plan.json");
  const story = findStory(plan, storyId);
  if (!story) throw Object.assign(new Error(`Story not found: ${storyId}`), { statusCode: 404 });
  if (story.status !== "approved") throw Object.assign(new Error("Test cases are available only after story approval"), { statusCode: 409 });
  return { story };
}

async function approvedTestCase(storyId: string, testCaseId: string) {
  const { story } = await approvedStory(storyId);
  const testCase = casesForStory(story).find(item => item.id === testCaseId);
  if (!testCase) throw Object.assign(new Error(`Test case not found: ${testCaseId}`), { statusCode: 404 });
  return { story, testCase };
}

async function queueCase(queue: ExecutionQueue, storyId: string, testCaseId: string, regenerateScript = false) {
  const job = await createExecutionJob({ storyId, testCaseId, regenerateScript });
  queue.enqueue(job);
  return job;
}

function sendError(res: import("express").Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    ? Number(error.statusCode)
    : /not found/i.test(message) ? 404 : 500;
  return res.status(statusCode).json({ error: message });
}
