import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../../../../packages/domain/src/atomicFile.js";
import { z } from "zod";
import { recordExecutionEvent } from "../../../../packages/playwright/services/executionHistory.js";
import type { CaseGenerationStage } from "../../../../packages/orchestration/src/executeApprovedCase.js";

export const StartExecutionRequestSchema = z.object({
  testCaseId: z.string().trim().min(1).optional(),
  storyId: z.string().trim().min(1).optional(),
  planPath: z.string().trim().min(1).optional(),
  regenerateScript: z.boolean().optional(),
}).strict().refine(body => Boolean(body.testCaseId) || Boolean(body.storyId), {
  message: "Provide testCaseId or storyId",
});

export type ExecutionCaseProgress = {
  testCaseId: string;
  title: string;
  status: "planning" | "executing" | "passed" | "failed" | "blocked";
  stage?: CaseGenerationStage;
  startedAt: string;
  finishedAt?: string;
  currentStep: number;
  totalSteps: number;
  activeStepId?: string;
  currentAction?: string;
  currentUrl?: string;
  locatorsFound?: number;
  confidence?: number;
  errorReason?: string;
  plannedSteps: string[];
  steps: Array<{ stepId: string; sourceStep: string; status: "passed" | "failed" | "blocked"; detail: string }>;
  expectedResult: string;
  actualResult?: string;
  failureType?: "application" | "automation";
  evidence?: Record<string, string>;
  aiAnalysis?: string;
  testData?: Array<{ name: string; value: string }>;
};

export type ExecutionJob = {
  executionId: string;
  testCaseId?: string;
  storyId?: string;
  planPath: string;
  regenerateScript?: boolean;
  status: "queued" | "planning" | "executing" | "passed" | "failed" | "blocked";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: {
    storyTitle: string;
    totalCases: number;
    completedCases: number;
    cases: ExecutionCaseProgress[];
    currentCase?: ExecutionCaseProgress;
    observation: Array<{ timestamp: string; text: string; status: "passed" | "failed" | "blocked" | "running" }>;
  };
  result?: unknown;
  error?: string;
};

const JOB_ROOT = "output/automation/jobs";

export async function createExecutionJob(input: unknown): Promise<ExecutionJob> {
  const request = StartExecutionRequestSchema.parse(input);
  const executionId = randomUUID();
  const job: ExecutionJob = {
    executionId,
    testCaseId: request.testCaseId,
    storyId: request.storyId,
    planPath: request.planPath ?? "output/sprint-plan.json",
    regenerateScript: request.regenerateScript,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  await saveExecutionJob(job);
  await recordExecutionEvent({ executionId, storyId: job.storyId, testCaseId: job.testCaseId, status: "queued", event: "api_job_created" });
  return job;
}

export async function getExecutionJob(executionId: string): Promise<ExecutionJob | undefined> {
  try {
    const text = await readFile(jobFile(executionId), "utf8");
    return JSON.parse(text) as ExecutionJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listExecutionJobs(): Promise<ExecutionJob[]> {
  let files: string[];
  try {
    files = await readdir(JOB_ROOT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs = await Promise.all(files
    .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
    .map(async file => {
      try {
        return JSON.parse(await readFile(path.join(JOB_ROOT, file), "utf8")) as ExecutionJob;
      } catch (error) {
        throw new Error(`Could not read execution job '${file}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  return jobs.sort((left, right) =>
    Date.parse(right.startedAt ?? right.createdAt) - Date.parse(left.startedAt ?? left.createdAt),
  );
}

export async function saveExecutionJob(job: ExecutionJob): Promise<void> {
  await mkdir(JOB_ROOT, { recursive: true });
  const file = jobFile(job.executionId);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(job, null, 2), "utf8");
    await renameWithRetry(temp, file);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temp).catch(cleanupError => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export async function listQueuedExecutionJobs(): Promise<ExecutionJob[]> {
  let files: string[];
  try {
    files = await readdir(JOB_ROOT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs = await Promise.all(files.filter(file => /^[a-f0-9-]{36}\.json$/i.test(file)).map(async file => {
    try {
      const job = JSON.parse(await readFile(path.join(JOB_ROOT, file), "utf8")) as ExecutionJob;
      return job.status === "queued" ? job : undefined;
    } catch (error) {
      throw new Error(`Could not restore execution job '${file}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  return jobs.filter((job): job is ExecutionJob => job !== undefined);
}

function jobFile(executionId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(executionId)) throw new Error("Invalid executionId");
  return path.join(JOB_ROOT, `${executionId}.json`);
}
