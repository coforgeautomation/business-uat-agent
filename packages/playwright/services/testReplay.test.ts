import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findFailedStepId, replayGeneratedTest } from "./testReplay.js";

test("maps Playwright's failure stack to the generated step comment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "replay-step-map-"));
  const file = path.join(directory, "TC-001.spec.ts");
  try {
    await writeFile(file, [
      'test("TC-001", async () => {',
      "  // S1",
      "  await page.goto(\"https://example.test/\");",
      "  // S2",
      "  await page.getByRole(\"button\", { name: \"Search\" }).click();",
      "});",
    ].join("\n"));
    const report = JSON.stringify({
      suites: [{
        specs: [{
          tests: [{
            results: [{
              status: "failed",
              errors: [{
                message: `Error: failure at ${file}:5:10`,
              }],
            }],
          }],
        }],
      }],
    });

    assert.equal(await findFailedStepId(report, file), "S2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay does not perform an extra Playwright retry", async () => {
  const root = path.resolve(__dirname, "../../..");
  const testFileName = `replay-retry-limit-${randomUUID()}.spec.ts`;
  const testFile = path.join(root, "packages", "playwright", "tests", testFileName);
  const executionId = randomUUID();
  const directory = await mkdtemp(path.join(os.tmpdir(), "replay-retry-limit-"));
  const attemptsFile = path.join(directory, "attempts.txt");
  const source = [
    'import { appendFileSync } from "node:fs";',
    'import { test } from "@playwright/test";',
    'test("intentional replay failure", async () => {',
    `  appendFileSync(${JSON.stringify(attemptsFile)}, "run\\n");`,
    '  throw new Error("intentional replay failure");',
    "});",
  ].join("\n");

  try {
    await writeFile(testFile, source);
    const replay = await replayGeneratedTest({
      file: path.join("packages", "playwright", "tests", testFileName),
      executionId,
      approvedAssertionTexts: [],
      approvedOptionNames: [],
    });

    assert.equal(replay.status, "blocked");
    const attempts = (await readFile(attemptsFile, "utf8")).trim().split(/\r?\n/);
    assert.equal(attempts.length, 1);
  } finally {
    await rm(testFile, { force: true });
    await rm(directory, { recursive: true, force: true });
    await rm(path.join(root, "output", "automation", "executions", executionId), {
      recursive: true,
      force: true,
    });
  }
});
