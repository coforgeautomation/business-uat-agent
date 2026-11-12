import type { ExecutionCaseProgress, ExecutionJob } from "../controllers/executionController.js";
import { getExecutionJob, saveExecutionJob } from "../controllers/executionController.js";
import { executeApprovedCase, type CaseProgressUpdate } from "../../../../packages/orchestration/src/executeApprovedCase.js";
import { executeStory } from "../../../../packages/orchestration/src/executeStory.js";
import { recordExecutionEvent } from "../../../../packages/playwright/services/executionHistory.js";

/** Runs one queued job; each case creates its own isolated MCP/browser session. */
export async function runExecutionWorker(job: ExecutionJob): Promise<void> {
  try {
    const latest = await getExecutionJob(job.executionId);
    if (!latest || latest.status !== "queued") throw new Error("Execution job is missing or is no longer queued");
    latest.status = "planning";
    latest.startedAt = new Date().toISOString();
    await saveExecutionJob(latest);
    await recordExecutionEvent({ executionId: latest.executionId, storyId: latest.storyId, testCaseId: latest.testCaseId, status: "planning", event: "worker_started" });

    latest.status = "executing";
    await saveExecutionJob(latest);
    let result;
    if (latest.testCaseId) result = await executeApprovedCase(latest.testCaseId, latest.planPath, async progress => {
      latest.progress = singleCaseProgress(latest, progress);
      await saveExecutionJob(latest);
    }, { regenerateScript: latest.regenerateScript, storyId: latest.storyId, jobExecutionId: latest.executionId });
    else if (latest.storyId) result = await executeStory(latest.storyId, latest.planPath, async progress => {
      latest.progress = progress;
      await saveExecutionJob(latest);
    }, { jobExecutionId: latest.executionId });
    else throw new Error("Queued execution has neither a testCaseId nor a storyId");

    latest.result = result;
    const resultStatus = "status" in result ? result.status : "failed";
    latest.status = resultStatus === "passed" ? "passed" : resultStatus === "blocked" ? "blocked" : "failed";
    latest.error = "error" in result && typeof result.error === "string" ? result.error : undefined;
    latest.finishedAt = new Date().toISOString();
    if (latest.testCaseId && latest.progress?.currentCase) {
      const artifacts = artifactsFromResult(result);
      const currentCase = {
        ...latest.progress.currentCase,
        finishedAt: latest.finishedAt,
        evidence: artifacts ?? latest.progress.currentCase.evidence,
      };
      latest.progress.currentCase = currentCase;
      latest.progress.cases = latest.progress.cases.map(testCase =>
        testCase.testCaseId === latest.testCaseId ? currentCase : testCase,
      );
    }
    await saveExecutionJob(latest);
    await recordExecutionEvent({ executionId: latest.executionId, storyId: latest.storyId, testCaseId: latest.testCaseId, status: latest.status, event: "worker_finished", details: { resultStatus } });
  } catch (error) {
    const latest = await getExecutionJob(job.executionId);
    if (latest) {
      latest.status = "failed";
      latest.finishedAt = new Date().toISOString();
      latest.error = error instanceof Error ? error.message : String(error);
      await saveExecutionJob(latest);
    }
    await recordExecutionEvent({ executionId: job.executionId, storyId: job.storyId, testCaseId: job.testCaseId, status: "failed", event: "worker_failed", details: error instanceof Error ? error.message : String(error) });
  }
}

function artifactsFromResult(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || !("artifacts" in value)) return undefined;
  const artifacts = value.artifacts;
  if (typeof artifacts !== "object" || artifacts === null || Array.isArray(artifacts)) return undefined;
  return Object.fromEntries(
    Object.entries(artifacts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function singleCaseProgress(
  job: ExecutionJob,
  update: CaseProgressUpdate,
): NonNullable<ExecutionJob["progress"]> {
  const observationText = update.observation ?? `${update.phase} ${job.testCaseId ?? ""}`;
  const observationStatus: "passed" | "failed" | "blocked" | "running" = update.phase === "finished"
    ? update.steps.some(step => step.status === "failed") ? "failed"
      : update.steps.some(step => step.status === "blocked") || /blocked/i.test(observationText) ? "blocked"
        : "passed"
    : "running";
  const caseStatus: ExecutionCaseProgress["status"] = update.phase === "finished"
    ? observationStatus === "running" ? "failed" : observationStatus
    : update.phase === "planning" ? "planning" : "executing";
  const currentCase: ExecutionCaseProgress = {
    testCaseId: job.testCaseId!,
    title: job.testCaseId!,
    status: caseStatus,
    stage: update.stage ?? (update.phase === "planning" ? "planning" : update.phase === "finished" ? "completed" : "exploring"),
    startedAt: job.startedAt ?? job.createdAt,
    currentStep: update.currentStep,
    totalSteps: update.totalSteps,
    activeStepId: update.activeStepId,
    currentAction: update.currentAction,
    currentUrl: update.currentUrl,
    locatorsFound: update.locatorsFound,
    confidence: update.confidence,
    errorReason: update.errorReason,
    plannedSteps: update.plannedSteps,
    steps: update.steps,
    expectedResult: "",
  };
  const priorObservations = job.progress?.observation ?? [];
  return {
    storyTitle: job.storyId ?? job.testCaseId!,
    totalCases: 1,
    completedCases: update.phase === "finished" ? 1 : 0,
    cases: [currentCase],
    currentCase,
    observation: [
      ...priorObservations,
      { timestamp: new Date().toISOString(), text: observationText, status: observationStatus },
    ].slice(-200),
  };
}
