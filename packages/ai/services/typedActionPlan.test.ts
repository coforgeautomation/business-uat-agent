import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { TestCaseSchema } from "../../domain/schemas/test-plan.schema.js";
import { ExecutionPlanSchema } from "../../domain/schemas/executionPlan.schema.js";
import {
  buildTypedActionPlan,
  normalizeApplicationNavigation,
} from "./typedActionPlan.js";
import { getApplicationBaseUrl } from "../../playwright/config/applicationConfig.js";

test("AIT-8 approved story cases compile to schema-valid plans preserving each source step", async () => {
  const content = await readFile(path.resolve("output/sprint-plan.json"), "utf8");
  const source = JSON.parse(content) as { stories: Array<{ storyId?: string; testCases?: unknown[] }> };
  const story = source.stories.find(item => item.storyId === "AIT-8");
  assert.ok(story, "AIT-8 must exist in the sprint plan");
  const testCases = (story.testCases ?? []).map(item => TestCaseSchema.parse(item));
  assert.equal(testCases.length, 9);

  for (const testCase of testCases) {
    const plan = ExecutionPlanSchema.parse(buildTypedActionPlan(testCase, "AIT-8"));
    const mappedSourceSteps = plan.steps.slice(0, testCase.steps.length).map(step => step.sourceStep);
    assert.deepEqual(mappedSourceSteps, testCase.steps, `${testCase.id} source steps remain unchanged and ordered`);
    assert.ok(
      plan.steps.some(step => step.action.startsWith("assert")
        && (testCase.steps.includes(step.sourceStep) || step.sourceStep === testCase.expectedOutcome)),
      `${testCase.id} retains an explicit or safely derived assertion`,
    );
  }

  const cabinSwitch = ExecutionPlanSchema.parse(
    buildTypedActionPlan(testCases[1], "AIT-8"),
  );
  assert.ok(cabinSwitch.steps.some(step => step.action === "assertSelected" && step.target === "Business"));
  assert.ok(cabinSwitch.steps.some(step => step.action === "assertUnselected" && step.target === "Economy"));
  assert.ok(cabinSwitch.steps.some(step => step.action === "assertUnselected" && step.target === "First"));
});

test("maps application readiness and airport suggestion waits deterministically", () => {
  const testCase = TestCaseSchema.parse({
    id: "AIT-8-TC-001",
    title: "Open and search airports",
    type: "positive",
    priority: "high",
    objective: "Enter the airport search values.",
    expectedOutcome: "The airport suggestions are available.",
    test_data: [
      { name: "origin_search", value: "Abu Dhabi" },
      { name: "destination_search", value: "Mumbai" },
    ],
    steps: [
      "Open application",
      "Wait for page load",
      "Enter origin_search in Origin field",
      "Wait for airport suggestions",
      "Enter destination_search in Destination field",
      "Wait for airport suggestions",
    ],
  });

  const plan = ExecutionPlanSchema.parse(buildTypedActionPlan(testCase));
  assert.deepEqual(plan.steps.map(step => step.action), [
    "navigate",
    "waitForLoad",
    "fill",
    "waitForText",
    "fill",
    "waitForText",
  ]);
  assert.deepEqual(
    plan.steps.filter(step => step.action === "waitForText").map(step => step.expected),
    ["Abu Dhabi", "Mumbai"],
  );
  assert.deepEqual(
    plan.steps.filter(step => step.action === "fill").map(step => step.valueRef),
    ["origin_search", "destination_search"],
  );
});

test("uses configured application URL instead of an AI-generated navigation data reference", () => {
  const normalized = normalizeApplicationNavigation({
    testCaseId: "AIT-8-TC-001",
    steps: [{
      id: "S1",
      sourceStep: "Open application",
      action: "navigate",
      valueRef: "application_url",
    }],
  }) as { steps: Array<{ value?: string; valueRef?: string }> };

  assert.equal(normalized.steps[0].value, getApplicationBaseUrl());
  assert.equal(normalized.steps[0].valueRef, undefined);
  assert.doesNotThrow(() => ExecutionPlanSchema.parse(normalized));
});

test("AIT-6 approved story cases compile to plans with an outcome assertion", async () => {
  const content = await readFile(path.resolve("output/sprint-plan.json"), "utf8");
  const source = JSON.parse(content) as { stories: Array<{ storyId?: string; testCases?: unknown[] }> };
  const story = source.stories.find(item => item.storyId === "AIT-6");
  assert.ok(story, "AIT-6 must exist in the sprint plan");
  const testCases = (story.testCases ?? []).map(item => TestCaseSchema.parse(item));
  assert.equal(testCases.length, 13);

  for (const testCase of testCases) {
    const plan = ExecutionPlanSchema.parse(buildTypedActionPlan(testCase, "AIT-6"));
    assert.ok(
      plan.steps.some(step => step.action.startsWith("assert")
        && (testCase.steps.includes(step.sourceStep) || step.sourceStep === testCase.expectedOutcome)),
      `${testCase.id} retains an explicit or safely derived assertion`,
    );
  }

  const clearedDestination = ExecutionPlanSchema.parse(buildTypedActionPlan(testCases[10], "AIT-6"));
  assert.ok(clearedDestination.steps.some(step =>
    step.action === "assertValue" && step.target === "Destination" && step.expected === "",
  ));
});

test("resolves test-data names used as values in approved airport-entry steps", () => {
  const testCase = TestCaseSchema.parse({
    id: "TC-001",
    title: "Enter test-data airport values",
    type: "positive",
    priority: "high",
    objective: "Verify airport test data is entered.",
    expectedOutcome: "The entered route is shown.",
    test_data: [
      { name: "originSearch", value: "Abu Dhabi" },
      { name: "destinationSearch", value: "London" },
    ],
    steps: [
      "Open application",
      "Enter originSearch in Origin field",
      "Enter destinationSearch in Destination field",
    ],
  });

  const plan = ExecutionPlanSchema.parse(buildTypedActionPlan(testCase, "AIT-8"));
  assert.deepEqual(
    plan.steps.slice(1).map(step => ({ value: step.value ?? null, valueRef: step.valueRef ?? null })),
    [
      { value: null, valueRef: "originSearch" },
      { value: null, valueRef: "destinationSearch" },
    ],
  );
});
