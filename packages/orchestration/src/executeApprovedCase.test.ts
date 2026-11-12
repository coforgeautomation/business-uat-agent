import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TestCaseSchema } from "../../domain/schemas/test-plan.schema.js";
import { generatedTestFilePath } from "../../playwright/services/testCodeGenerator.js";
import { getScriptMetadata } from "../../playwright/services/automationRepository.js";
import { runCase } from "./executeApprovedCase.js";

test("stops after one retry and leaves failed existing automation marked for healing", async () => {
  const root = path.resolve(__dirname, "../../..");
  const storyId = `retry-limit-${randomUUID()}`;
  const testCaseId = `TC-${randomUUID()}`;
  const testCase = TestCaseSchema.parse({
    id: testCaseId,
    title: "Stop after one failed retry",
    type: "negative",
    priority: "high",
    objective: "Verify retries are capped.",
    steps: ["First step fails", "Later step must not run"],
    expectedOutcome: "A failed test is marked for healing.",
  });
  const file = generatedTestFilePath(storyId, testCaseId);
  const attemptsDirectory = await mkdtemp(path.join(os.tmpdir(), "execute-case-retry-limit-"));
  const attemptsFile = path.join(attemptsDirectory, "attempts.txt");
  const executionOutput = path.join(root, "output", "automation", "executions");
  let outcome: Awaited<ReturnType<typeof runCase>> | undefined;

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      'import { appendFileSync } from "node:fs";',
      'import { test } from "@playwright/test";',
      `test(${JSON.stringify(testCaseId)}, async () => {`,
      "  // S1",
      '  await test.step("S1: First step fails", async () => {',
      `    appendFileSync(${JSON.stringify(attemptsFile)}, "first\\n");`,
      '    throw new Error("intentional automation failure");',
      "  });",
      "  // S2",
      '  await test.step("S2: Later step must not run", async () => {',
      `    appendFileSync(${JSON.stringify(attemptsFile)}, "later\\n");`,
      "  });",
      "});",
    ].join("\n"));

    outcome = await runCase(testCase, { id: storyId, title: "Retry policy test" });

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.recovery?.strategy, "retry-exhausted");
    assert.equal((await getScriptMetadata(storyId, testCaseId))?.status, "NEEDS_HEALING");
    assert.deepEqual((await readFile(attemptsFile, "utf8")).trim().split(/\r?\n/), ["first", "first"]);
  } finally {
    await rm(file, { force: true });
    await rm(path.dirname(file), { recursive: true, force: true });
    await rm(path.join(root, "output", "automation", "script-repository", storyId), {
      recursive: true,
      force: true,
    });
    await rm(path.join(root, "output", "automation", "execution-state", storyId), {
      recursive: true,
      force: true,
    });
    if (outcome) {
      await rm(path.join(executionOutput, outcome.executionId), { recursive: true, force: true });
    }
    await rm(attemptsDirectory, { recursive: true, force: true });
  }
});
