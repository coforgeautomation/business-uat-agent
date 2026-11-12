import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointFromProgress } from "./automationRepository.js";

test("persists the failed step and last successful checkpoint", () => {
  const checkpoint = checkpointFromProgress({
    storyId: "AIT-8",
    testCaseId: "TC-004",
    executionId: "execution-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    phase: "finished",
    currentStep: 3,
    steps: [
      { stepId: "S1", sourceStep: "Open", status: "passed", detail: "done" },
      { stepId: "S2", sourceStep: "Origin", status: "passed", detail: "done" },
      { stepId: "S3", sourceStep: "Destination", status: "passed", detail: "done" },
      { stepId: "S4", sourceStep: "Search", status: "failed", detail: "locator missing" },
    ],
  });

  assert.equal(checkpoint.lastPassedStep, 3);
  assert.equal(checkpoint.lastExecutedStep, 4);
  assert.equal(checkpoint.status, "FAILED");
  assert.equal(checkpoint.lastError, "locator missing");
  assert.ok(checkpoint.endedAt);
});
