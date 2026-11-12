import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlannedStep } from "../schemas/actionPlan.schema.js";
import { McpExecutionPlanner } from "./mcpExecutionPlanner.js";

const approvedStep: PlannedStep = {
  id: "S1",
  sourceStep: "Click Search",
  action: "click",
  target: "Search",
};

test("MCP planner may change only the target and retains the approved step intent", async () => {
  let submitted = "";
  const planner = new McpExecutionPlanner({
    chat: async messages => {
      submitted = messages[1].content;
      return JSON.stringify({
        status: "retry",
        target: "Search flights",
        reason: "The live snapshot exposes one button with this accessible name.",
      });
    },
  });

  const result = await planner.suggestAlternateStep({
    testCase: {
      id: "TC-001",
      title: "Search flights",
      objective: "Submit the flight search.",
      expectedOutcome: "The search results are shown.",
    },
    step: approvedStep,
    snapshot: '- button "Search flights" [ref=search-1]',
    failure: "The original target was ambiguous.",
    attempt: 1,
  });

  assert.ok("step" in result);
  assert.deepEqual(result.step, { ...approvedStep, target: "Search flights" });
  assert.match(submitted, /Search flights/);
  assert.match(submitted, /The original target was ambiguous/);
});

test("MCP planner returns an explicit blocked reason without proposing an action", async () => {
  const planner = new McpExecutionPlanner({
    chat: async () => JSON.stringify({
      status: "blocked",
      reason: "The current snapshot does not contain a matching control.",
    }),
  });

  const result = await planner.suggestAlternateStep({
    testCase: {
      id: "TC-001",
      title: "Search flights",
      objective: "Submit the flight search.",
      expectedOutcome: "The search results are shown.",
    },
    step: approvedStep,
    snapshot: "No search control is exposed.",
    failure: "Target not found.",
    attempt: 1,
  });

  assert.deepEqual(result, {
    blockedReason: "The current snapshot does not contain a matching control.",
  });
});

test("MCP planner never retries a booking or payment action", async () => {
  let modelCalled = false;
  const planner = new McpExecutionPlanner({
    chat: async () => {
      modelCalled = true;
      return "";
    },
  });

  const result = await planner.suggestAlternateStep({
    testCase: {
      id: "TC-002",
      title: "Complete payment",
      objective: "Pay for the selected flight.",
      expectedOutcome: "The payment is accepted.",
    },
    step: {
      ...approvedStep,
      sourceStep: "Click Pay now",
      target: "Pay now",
    },
    snapshot: '- button "Pay now" [ref=pay]',
    failure: "Locator failed.",
    attempt: 1,
  });

  assert.deepEqual(result, {
    blockedReason: "Recovery is disabled for steps that may complete a booking, payment, or purchase.",
  });
  assert.equal(modelCalled, false);
});

test("MCP planner rejects selector output and malformed decisions", async () => {
  const planner = new McpExecutionPlanner({
    chat: async () => JSON.stringify({
      status: "retry",
      target: "button#search",
      reason: "Selector supplied.",
    }),
  });
  const context = {
    testCase: {
      id: "TC-001",
      title: "Search flights",
      objective: "Submit the flight search.",
      expectedOutcome: "The search results are shown.",
    },
    step: approvedStep,
    snapshot: '- button "Search" [ref=search]',
    failure: "Target not found.",
    attempt: 1,
  };

  await assert.rejects(planner.suggestAlternateStep(context), /selector instead of an evidence-backed semantic target/);

  const malformed = new McpExecutionPlanner({ chat: async () => "not json" });
  await assert.rejects(malformed.suggestAlternateStep(context), /invalid JSON/);
});
