import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { test } from "node:test";
import ExecutionProgressReporter from "./executionProgressReporter.js";

test("writes business-step start and completion events for live polling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "playwright-progress-"));
  const progressFile = path.join(directory, "progress.jsonl");
  const previous = process.env.PLAYWRIGHT_EXECUTION_PROGRESS_FILE;
  process.env.PLAYWRIGHT_EXECUTION_PROGRESS_FILE = progressFile;
  try {
    const reporter = new ExecutionProgressReporter();
    const testCase = { location: { file: "generated.spec.ts" } } as TestCase;
    const result = {} as TestResult;
    const step = {
      title: "S2: Select destination",
      category: "test.step",
      location: { file: "generated.spec.ts", line: 4, column: 1 },
    } as TestStep;

    reporter.onStepBegin(testCase, result, step);
    reporter.onStepEnd(testCase, result, step);

    const events = (await readFile(progressFile, "utf8"))
      .trim()
      .split("\n")
      .map(line => {
        const event = JSON.parse(line) as { stepId: string; status: string };
        return { stepId: event.stepId, status: event.status };
      });
    assert.deepEqual(events, [
      { stepId: "S2", status: "running" },
      { stepId: "S2", status: "passed" },
    ]);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_EXECUTION_PROGRESS_FILE;
    else process.env.PLAYWRIGHT_EXECUTION_PROGRESS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
