import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../../domain/src/atomicFile.js";
import type { StepResult } from "./stepExecutor.js";

export const AutomationLifecycleStatus = [
  "NOT_GENERATED",
  "GENERATING",
  "GENERATED",
  "EXECUTING",
  "PASSED",
  "FAILED",
  "NEEDS_HEALING",
  "HEALING",
  "HEALED",
  "BLOCKED",
] as const;

export type AutomationLifecycleStatus = typeof AutomationLifecycleStatus[number];

export type ScriptMetadata = {
  storyId: string;
  testCaseId: string;
  scriptPath?: string;
  status: AutomationLifecycleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastExecutionAt?: string;
  lastHealingAt?: string;
  lastPassedStep: number;
};

export type ExecutionCheckpoint = {
  storyId: string;
  testCaseId: string;
  executionId: string;
  lastPassedStep: number;
  lastExecutedStep: number;
  status: "EXECUTING" | "PASSED" | "FAILED" | "BLOCKED";
  startedAt: string;
  endedAt?: string;
  lastError?: string;
};

const ROOT = path.resolve("output/automation");

export async function getScriptMetadata(
  storyId: string,
  testCaseId: string,
): Promise<ScriptMetadata | undefined> {
  return readJson<ScriptMetadata>(metadataFile(storyId, testCaseId));
}

export async function updateScriptMetadata(
  storyId: string,
  testCaseId: string,
  update: Partial<Omit<ScriptMetadata, "storyId" | "testCaseId" | "createdAt">>,
): Promise<ScriptMetadata> {
  const file = metadataFile(storyId, testCaseId);
  const existing = await readJson<ScriptMetadata>(file);
  const timestamp = new Date().toISOString();
  const metadata: ScriptMetadata = {
    storyId,
    testCaseId,
    status: "NOT_GENERATED",
    version: 0,
    createdAt: timestamp,
    lastPassedStep: 0,
    ...existing,
    ...update,
    updatedAt: timestamp,
  };
  await writeJson(file, metadata);
  return metadata;
}

export async function saveExecutionCheckpoint(
  checkpoint: ExecutionCheckpoint,
): Promise<void> {
  await writeJson(checkpointFile(checkpoint.storyId, checkpoint.testCaseId), checkpoint);
}

export async function getExecutionCheckpoint(
  storyId: string,
  testCaseId: string,
): Promise<ExecutionCheckpoint | undefined> {
  return readJson<ExecutionCheckpoint>(checkpointFile(storyId, testCaseId));
}

function metadataFile(storyId: string, testCaseId: string): string {
  return path.join(ROOT, "script-repository", safeName(storyId), `${safeName(testCaseId)}.json`);
}

function checkpointFile(storyId: string, testCaseId: string): string {
  return path.join(ROOT, "execution-state", safeName(storyId), `${safeName(testCaseId)}.json`);
}

function safeName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid story or test case identifier");
  return safe;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await renameWithRetry(temporary, file);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(cleanupError => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export function checkpointFromProgress(input: {
  storyId: string;
  testCaseId: string;
  executionId: string;
  startedAt: string;
  phase: "planning" | "executing" | "finished";
  currentStep: number;
  activeStepId?: string;
  steps: StepResult[];
  observation?: string;
}): ExecutionCheckpoint {
  const lastPassedStep = input.steps.reduce((last, step) => {
    if (step.status !== "passed") return last;
    const index = Number(step.stepId.slice(1));
    return Number.isInteger(index) ? Math.max(last, index) : last;
  }, 0);
  const lastExecutedStep = input.activeStepId
    ? Number(input.activeStepId.slice(1))
    : input.steps.reduce((last, step) => {
        const index = Number(step.stepId.slice(1));
        return Number.isInteger(index) ? Math.max(last, index) : last;
      }, lastPassedStep);
  const failedStep = input.steps.find(step => step.status === "failed" || step.status === "blocked");
  const isFinished = input.phase === "finished";
  const observation = input.observation ?? "";
  const status = isFinished
    ? failedStep?.status === "failed" || /failed/i.test(observation) ? "FAILED"
      : failedStep?.status === "blocked" || /blocked/i.test(observation) ? "BLOCKED"
        : "PASSED"
    : "EXECUTING";

  return {
    storyId: input.storyId,
    testCaseId: input.testCaseId,
    executionId: input.executionId,
    lastPassedStep,
    lastExecutedStep: Number.isInteger(lastExecutedStep) ? lastExecutedStep : input.currentStep,
    status,
    startedAt: input.startedAt,
    endedAt: isFinished ? new Date().toISOString() : undefined,
    lastError: failedStep?.detail,
  };
}
