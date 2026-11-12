import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../../../../packages/domain/src/atomicFile.js";

export type AutomationGenerationBatchCase = {
  testCaseId: string;
  title: string;
  initialStage?: "queued" | "completed";
  confidence?: number;
  executionId?: string;
  executionIds?: string[];
  failureReason?: string;
};

export type AutomationGenerationBatch = {
  batchId: string;
  storyId: string;
  status: "queued" | "running" | "paused" | "completed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cases: AutomationGenerationBatchCase[];
};

const BATCH_ROOT = path.resolve("output/automation/generation-batches");

export async function createAutomationGenerationBatch(
  storyId: string,
  cases: Array<Pick<AutomationGenerationBatchCase, "testCaseId" | "title" | "initialStage" | "confidence">>,
): Promise<AutomationGenerationBatch> {
  const timestamp = new Date().toISOString();
  const batch: AutomationGenerationBatch = {
    batchId: randomUUID(),
    storyId,
    status: "queued",
    createdAt: timestamp,
    cases,
  };
  await saveAutomationGenerationBatch(batch);
  return batch;
}

export async function getAutomationGenerationBatch(batchId: string) {
  try {
    return JSON.parse(await readFile(batchFile(batchId), "utf8")) as AutomationGenerationBatch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listAutomationGenerationBatches() {
  let files: string[];
  try {
    files = await readdir(BATCH_ROOT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const batches = await Promise.all(files
    .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
    .map(async file => {
      try {
        return JSON.parse(await readFile(path.join(BATCH_ROOT, file), "utf8")) as AutomationGenerationBatch;
      } catch (error) {
        throw new Error(`Could not read automation generation batch '${file}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  return batches;
}

export async function updateAutomationGenerationBatch(
  batchId: string,
  update: (batch: AutomationGenerationBatch) => void,
): Promise<AutomationGenerationBatch> {
  const batch = await getAutomationGenerationBatch(batchId);
  if (!batch) throw new Error(`Automation generation batch not found: ${batchId}`);
  update(batch);
  await saveAutomationGenerationBatch(batch);
  return batch;
}

async function saveAutomationGenerationBatch(batch: AutomationGenerationBatch) {
  await mkdir(BATCH_ROOT, { recursive: true });
  const file = batchFile(batch.batchId);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(batch, null, 2), "utf8");
    await renameWithRetry(temporary, file);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(cleanupError => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

function batchFile(batchId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(batchId)) throw new Error("Invalid automation generation batchId");
  return path.join(BATCH_ROOT, `${batchId}.json`);
}
