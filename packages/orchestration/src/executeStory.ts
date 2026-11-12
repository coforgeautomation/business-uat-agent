import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordExecutionEvent } from "../../playwright/services/executionHistory";
import { getLocatorMetrics } from "../../playwright/services/locatorMetrics";
import type { ExecutionStatus } from "../../domain/src/testPlan";
import { casesForStory, findStory, readApprovedPlan } from "./planReader.js";
import { runCase } from "./executeApprovedCase.js";
import type { CaseProgressUpdate } from "./executeApprovedCase.js";
import type { StepResult } from "../../playwright/services/stepExecutor.js";

export type StoryProgressCase = {
  testCaseId: string;
  title: string;
  status: "planning" | "executing" | "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt?: string;
  currentStep: number;
  totalSteps: number;
  activeStepId?: string;
  plannedSteps: string[];
  steps: StepResult[];
  expectedResult: string;
  actualResult?: string;
  failureType?: "application" | "automation";
  evidence?: Record<string, string>;
  aiAnalysis?: string;
  testData?: Array<{ name: string; value: string }>;
};

export type StoryProgressUpdate = {
  storyTitle: string;
  totalCases: number;
  completedCases: number;
  cases: StoryProgressCase[];
  currentCase?: StoryProgressCase;
  observation: { timestamp: string; text: string; status: "passed" | "failed" | "blocked" | "running" }[];
};

/** Runs all cases in one story sequentially; separate jobs may use queue concurrency. */
export async function executeStory(
  storyId: string,
  planPath = "output/sprint-plan.json",
  onProgress?: (progress: StoryProgressUpdate) => void | Promise<void>,
  options: { jobExecutionId?: string } = {},
) {
  const plan = await readApprovedPlan(planPath);
  const story = findStory(plan, storyId);
  if (!story) throw new Error(`Story not found: ${storyId}`);
  const cases = casesForStory(story);
  if (!cases.length) throw new Error(`Story '${storyId}' has no test cases`);

  const batchId = randomUUID();
  const root = path.resolve(__dirname, "../../..");
  const outputDir = path.join(root, "output/automation/executions", batchId);
  await mkdir(outputDir, { recursive: true });
  const historyPath = path.join(outputDir, "history.jsonl");
  const metricsPath = path.join(outputDir, "metrics.json");
  const resultPath = path.join(outputDir, "result.json");
  await recordExecutionEvent({ executionId: batchId, storyId: story.id, status: "executing", event: "story_batch_started", details: { caseCount: cases.length } });

  const results = [];
  const caseProgress: StoryProgressCase[] = [];
  const observations: StoryProgressUpdate["observation"] = [];
  const publishProgress = async (currentCase?: StoryProgressCase) => {
    await onProgress?.({
      storyTitle: story.title,
      totalCases: cases.length,
      completedCases: results.length,
      cases: [...caseProgress],
      currentCase,
      observation: observations.slice(-100),
    });
  };
  for (const testCase of cases) {
    const current: StoryProgressCase = {
      testCaseId: testCase.id,
      title: redactCaseData(testCase.title, testCase),
      status: "planning",
      startedAt: new Date().toISOString(),
      currentStep: 0,
      totalSteps: testCase.steps.length,
      plannedSteps: testCase.steps.map(step => redactCaseData(step, testCase)),
      steps: [],
      expectedResult: redactCaseData(testCase.expectedOutcome, testCase),
      testData: (testCase.test_data ?? []).map(({ name }) => ({ name, value: "[REDACTED]" })),
    };
    caseProgress.push(current);
    observations.push({ timestamp: new Date().toISOString(), text: redactCaseData(`Started ${testCase.id}: ${testCase.title}`, testCase), status: "running" });
    await publishProgress(current);
    const result = await runCase(testCase, story, planPath, async (update: CaseProgressUpdate) => {
      current.status = update.phase === "finished" ? resultStatusFromUpdate(update) : update.phase;
      current.currentStep = update.currentStep;
      current.totalSteps = update.totalSteps;
      current.activeStepId = update.activeStepId;
      current.plannedSteps = update.plannedSteps.map(step => redactCaseData(step, testCase));
      current.steps = update.steps;
      if (update.observation) {
        observations.push({
          timestamp: new Date().toISOString(),
          text: update.observation,
          status: update.phase === "finished"
            ? current.status === "failed" ? "failed" : current.status === "blocked" ? "blocked" : "passed"
            : update.phase === "executing" ? "running" : "running",
        });
      }
      await publishProgress(current);
    }, options);
    current.status = caseStatus(result.status);
    current.finishedAt = new Date().toISOString();
    current.currentStep = result.steps.length;
    current.totalSteps = Math.max(current.totalSteps, result.steps.length);
    current.steps = result.steps;
    current.failureType = result.failureType;
    current.actualResult = redactCaseData(result.error ?? result.steps.filter(step => step.status === "passed").at(-1)?.detail ?? "", testCase);
    current.evidence = result.artifacts;
    const diagnosis = result.healer && typeof result.healer === "object" && "diagnosis" in result.healer
      ? result.healer.diagnosis
      : undefined;
    current.aiAnalysis = diagnosis && typeof diagnosis === "object" && "reason" in diagnosis
      ? redactCaseData(String(diagnosis.reason), testCase)
      : current.actualResult;
    current.expectedResult = redactCaseData(current.expectedResult, testCase);
    current.steps = current.steps.map(step => ({
      ...step,
      sourceStep: redactCaseData(step.sourceStep, testCase),
      detail: redactCaseData(step.detail, testCase),
    }));
    observations.push({
      timestamp: new Date().toISOString(),
      text: `${testCase.id} ${result.status}`,
      status: result.status === "passed" || result.status === "failed" || result.status === "blocked"
        ? result.status
        : "running",
    });
    results.push(result);
    await publishProgress();
    await recordExecutionEvent({
      executionId: batchId,
      storyId: story.id,
      testCaseId: testCase.id,
      status: caseStatus(result.status),
      event: "story_case_finished",
      details: { childExecutionId: result.executionId, artifacts: result.artifacts },
    });
  }

  const passed = results.filter(result => result.status === "passed").length;
  const failed = results.filter(result => result.status === "failed").length;
  const blocked = results.filter(result => result.status === "blocked").length;
  const status: ExecutionStatus = failed ? "failed" : blocked ? "blocked" : "passed";
  const summary = {
    batchId,
    storyId: story.id,
    status,
    totals: { total: results.length, passed, failed, blocked },
    results,
    locatorMetrics: await getLocatorMetrics(),
    artifacts: { result: resultPath, history: historyPath, metrics: metricsPath },
  };
  await writeFile(metricsPath, JSON.stringify(summary.locatorMetrics, null, 2));
  await writeFile(resultPath, JSON.stringify(summary, null, 2));
  await publishProgress();
  await recordExecutionEvent({ executionId: batchId, storyId: story.id, status, event: "story_batch_finished", details: { ...summary.totals, artifacts: summary.artifacts } });
  return summary;
}

function resultStatusFromUpdate(update: CaseProgressUpdate): StoryProgressCase["status"] {
  const failed = update.steps.find(step => step.status === "failed");
  if (failed) return "failed";
  if (update.steps.some(step => step.status === "blocked")) return "blocked";
  return "passed";
}

function caseStatus(status: ExecutionStatus): StoryProgressCase["status"] {
  if (status === "passed" || status === "failed" || status === "blocked") return status;
  return "executing";
}

function redactCaseData(value: string, testCase: { test_data?: Array<{ value: string | number | boolean }> }): string {
  let redacted = value;
  for (const { value: sensitive } of [...(testCase.test_data ?? [])].sort((a, b) => String(b.value).length - String(a.value).length)) {
    const text = String(sensitive);
    if (text) redacted = redacted.split(text).join("[REDACTED]");
  }
  return redacted;
}
