import assert from "node:assert/strict";
import { test } from "node:test";
import { TestCaseSchema } from "../../domain/schemas/test-plan.schema.js";
import {
  buildTypedActionPlan,
  validatePlanActionIntents,
} from "./typedActionPlan.js";

test("maps explicit selection and text verification steps to assertion actions", () => {
  const testCase = TestCaseSchema.parse({
    id: "TC-VERIFY",
    title: "Verify selected cabin",
    type: "positive",
    priority: "medium",
    objective: "Verify the selected cabin state.",
    expectedOutcome: "The plan completes.",
    steps: [
      "Open application",
      "Verify Business is selected",
      "Verify Economy is not selected",
      "Verify Search results contains text Flights",
    ],
  });

  const plan = buildTypedActionPlan(testCase);
  assert.deepEqual(plan.steps.map(step => step.action), [
    "navigate",
    "assertSelected",
    "assertUnselected",
    "assertText",
  ]);
  assert.equal(plan.steps[3].target, "Search results");
  assert.equal(plan.steps[3].expected, "Flights");
});

test("does not copy an unrelated assertion to stand in for an unknown expected outcome", () => {
  const testCase = TestCaseSchema.parse({
    id: "TC-NO-FABRICATED-ASSERTION",
    title: "Preserve verification intent",
    type: "positive",
    priority: "medium",
    objective: "Keep only explicitly supported verification.",
    expectedOutcome: "The booking summary reflects the selected journey.",
    steps: [
      "Open application",
      "Verify Round Trip is visible",
    ],
  });

  const plan = buildTypedActionPlan(testCase);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].sourceStep, "Verify Round Trip is visible");
});

test("rejects an AI action type that conflicts with the approved verification wording", () => {
  const testCase = TestCaseSchema.parse({
    id: "TC-VERIFY-INTENT",
    title: "Verify selected cabin",
    type: "positive",
    priority: "medium",
    objective: "Verify the selected cabin state.",
    expectedOutcome: "Business is selected.",
    steps: ["Verify Business is selected"],
  });

  assert.throws(
    () => validatePlanActionIntents({
      steps: [{ sourceStep: "Verify Business is selected", action: "click" }],
    }, testCase),
    /expected assertSelected, received click/,
  );
});
