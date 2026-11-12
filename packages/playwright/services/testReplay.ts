import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { recordExecutionEvent } from "./executionHistory.js";
import { testDataEnvironment } from "../test-data/runtimeTestData.js";

const execFileAsync = promisify(execFile);

export type ReplayArtifacts = {
  screenshot?: string;
  trace?: string;
  video?: string;
  errorContext?: string;
};

export type ReplayResult = {
  status: "passed" | "failed" | "blocked";
  failureType?: "application" | "automation";
  failedStepId?: string;
  failureMessage?: string;
  file: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts?: ReplayArtifacts;
};

export type ReplayStepProgress = {
  stepId: string;
  status: "running" | "passed" | "failed";
  detail: string;
  timestamp: string;
};

export async function replayGeneratedTest(input: {
  file: string;
  executionId: string;
  approvedAssertionTexts: string[];
  approvedOptionNames: string[];
  testData?: Record<string, unknown>;
  timeoutMs?: number;
  attemptName?: string;
  onStepProgress?: (progress: ReplayStepProgress) => void | Promise<void>;
}): Promise<ReplayResult> {
  const started = Date.now();
  const attemptName = input.attemptName?.replace(/[^a-zA-Z0-9_-]+/g, "_");
  await recordExecutionEvent({
    executionId: input.executionId,
    status: "replaying",
    event: "replay_started",
    details: { file: input.file, attemptName },
  });
  const root = path.resolve(__dirname, "../../..");
  const file = path.resolve(root, input.file);
  const testDir = path.join(root, "packages", "playwright", "tests");
  const artifactDir = path.join(
    root,
    "output",
    "automation",
    "executions",
    input.executionId,
    attemptName ? `replay-${attemptName}` : "replay",
  );
  const testArgument = path.relative(testDir, file).replace(/\\/g, "/");
  if (testArgument.startsWith("..")) {
    throw new Error(`Generated test must be inside Playwright testDir (${testDir}): ${file}`);
  }
  const playwrightCli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
  const progressFile = path.join(artifactDir, "step-progress.jsonl");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(progressFile, "", "utf8");
  try {
    const execution = execFileAsync(process.execPath, [
      playwrightCli, "test", testArgument, "--project=chromium",
      "--retries=0",
      "--output", path.join(artifactDir, "playwright-results"),
    ], {
      timeout: input.timeoutMs ?? 180_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...testDataEnvironment(input.testData ?? {}),
        PLAYWRIGHT_EXECUTION_PROGRESS_FILE: progressFile,
      },
      cwd: root,
    });
    let settled = false;
    void execution.then(() => { settled = true; }, () => { settled = true; });
    let publishedLines = 0;
    let progressError: unknown;
    const publish = async () => {
      try {
        publishedLines = await publishStepProgress(progressFile, publishedLines, input.onStepProgress);
      } catch (error) {
        progressError ??= error;
      }
    };
    while (!settled) {
      await publish();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await publish();
    const result = await execution;
    if (progressError) throw progressError;
    const replay: ReplayResult = {
      status: "passed", file, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - started,
      artifacts: await copyReplayArtifacts(result.stdout, artifactDir),
    };
    await recordExecutionEvent({ executionId: input.executionId, status: "passed", event: "replay_finished", details: replay });
    return replay;
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? e.message;
    const failures = parseFailedAssertions(stdout);
    const failedStepId = await findFailedStepId(stdout, file);
    const failureType = failures.some(message => isApprovedApplicationFailure(
      message,
      input.approvedAssertionTexts,
      input.approvedOptionNames,
    ))
      ? "application"
      : "automation";
    const replay: ReplayResult = {
      status: failureType === "application" ? "failed" : "blocked",
      failureType,
      failedStepId,
      failureMessage: failures[0] ?? stderr,
      file,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      artifacts: await copyReplayArtifacts(stdout, artifactDir),
    };
    await recordExecutionEvent({
      executionId: input.executionId,
      status: replay.status,
      event: replay.status === "failed" ? "replay_failed" : "replay_blocked",
      details: { ...replay, failures },
    });
    return replay;
  }
}

async function publishStepProgress(
  file: string,
  publishedLines: number,
  onProgress?: (progress: ReplayStepProgress) => void | Promise<void>,
): Promise<number> {
  const contents = await readFile(file, "utf8");
  const lines = contents.split("\n");
  const completeLines = lines.length - 1;
  for (const line of lines.slice(publishedLines, completeLines)) {
    if (!line) continue;
    await onProgress?.(JSON.parse(line) as ReplayStepProgress);
  }
  return completeLines;
}

export async function findFailedStepId(output: string, file: string): Promise<string | undefined> {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return undefined;
  }
  const fileName = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linePattern = new RegExp(`${fileName}:(\\d+):\\d+`, "gi");
  const lines: number[] = [];
  collectFailureLines(report, path.basename(file), linePattern, lines);
  if (!lines.length) return undefined;

  const source = (await readFile(file, "utf8")).split(/\r?\n/);
  for (const lineNumber of lines) {
    for (let index = Math.min(lineNumber - 1, source.length - 1); index >= 0; index -= 1) {
      const marker = source[index].match(/^\s*\/\/\s*(S\d+)\s*$/);
      if (marker) return marker[1];
    }
  }
  return undefined;
}

function collectFailureLines(value: unknown, fileName: string, linePattern: RegExp, lines: number[]) {
  if (Array.isArray(value)) {
    value.forEach(item => collectFailureLines(item, fileName, linePattern, lines));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.status === "failed" && Array.isArray(record.errors)) {
    for (const item of record.errors) {
      if (typeof item !== "object" || item === null) continue;
      const error = item as Record<string, unknown>;
      if (typeof error.message === "string") {
        for (const match of error.message.matchAll(linePattern)) lines.push(Number(match[1]));
      }
      if (typeof error.location === "object" && error.location !== null) {
        const location = error.location as Record<string, unknown>;
        if (typeof location.file === "string" && typeof location.line === "number") {
          const normalized = location.file.replace(/\\/g, "/");
          if (normalized.endsWith(`/${fileName}`)) lines.push(location.line);
        }
      }
    }
  }
  Object.values(record).forEach(item => collectFailureLines(item, fileName, linePattern, lines));
}

async function copyReplayArtifacts(output: string, artifactDir: string): Promise<ReplayArtifacts> {
  const sourceArtifacts = collectAttachments(output);
  const copied: ReplayArtifacts = {};
  for (const [name, source] of Object.entries(sourceArtifacts)) {
    if (!source) continue;
    try {
      await access(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await mkdir(artifactDir, { recursive: true });
    const extension = path.extname(source);
    const destination = path.join(artifactDir, `${name}${extension}`);
    await copyFile(source, destination);
    copied[name as keyof ReplayArtifacts] = destination;
  }
  return copied;
}

function collectAttachments(output: string): ReplayArtifacts {
  let report: unknown;
  try { report = JSON.parse(output); } catch { return {}; }
  const result: ReplayArtifacts = {};
  visit(report);
  return result;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.attachments)) {
      for (const attachment of record.attachments) {
        if (typeof attachment !== "object" || attachment === null) continue;
        const item = attachment as Record<string, unknown>;
        if (typeof item.name !== "string" || typeof item.path !== "string") continue;
        const name = item.name === "error-context" ? "errorContext" : item.name;
        if (name === "screenshot" || name === "trace" || name === "video" || name === "errorContext") {
          result[name as keyof ReplayArtifacts] = item.path;
        }
      }
    }
    Object.values(record).forEach(visit);
  }
}

function parseFailedAssertions(output: string): string[] {
  try {
    const report: unknown = JSON.parse(output);
    const errors: string[] = [];
    collectFailedResults(report, errors);
    return errors;
  } catch {
    return [];
  }
}

function collectFailedResults(value: unknown, errors: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectFailedResults(item, errors);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.status === "failed" && Array.isArray(record.errors)) {
    for (const item of record.errors) {
      if (typeof item === "object" && item !== null && "message" in item && typeof item.message === "string") {
        errors.push(item.message);
      }
    }
  }
  for (const item of Object.values(record)) collectFailedResults(item, errors);
}

function isApprovedApplicationFailure(
  message: string,
  approvedAssertionTexts: string[],
  approvedOptionNames: string[],
) {
  if (approvedAssertionTexts.some(text => text.length > 0 && message.includes(text))) return true;
  const expectedOption = /Locator:\s*getByRole\(['"]option['"]/.test(message)
    && /(element\(s\) not found|Received:\s*(?:\u001b\[[\d;]*m)*0|resolved to 0 elements)/i.test(message);
  return expectedOption && approvedOptionNames.some(name => name.length > 0 && message.includes(name));
}
