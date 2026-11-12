import assert from "node:assert/strict";
import { test } from "node:test";
import { TestPlanSchema } from "../../domain/schemas/test-plan.schema.js";
import { buildPlannerPrompt } from "./planner.prompt.js";
import { linkTestCaseIdsToStory } from "../services/planner.service.js";

test("planner prompt JSON example validates against the TestPlan schema", () => {
  const prompt = buildPlannerPrompt("Requirement", "Domain context");
  const match = prompt.match(/(\{\n  "storyId":[\s\S]*?\n\})\n\nSchema constraints:/);
  assert.ok(match, "planner prompt includes its JSON example");
  assert.doesNotThrow(() => TestPlanSchema.parse(JSON.parse(match[1])));
});

test("planner prompt includes the supplied requirement and domain context", () => {
  const prompt = buildPlannerPrompt("Supplied requirement", "Supplied domain rules");
  assert.ok(prompt.includes("Supplied requirement"));
  assert.ok(prompt.includes("Supplied domain rules"));
});

test("planner prompt spells out exact test data and clarification schema keys", () => {
  const prompt = buildPlannerPrompt("Requirement", "Domain context");
  assert.match(prompt, /test_data entry MUST use exactly the keys "name" and "value"/);
  assert.match(prompt, /The key\s+is "name", never "key"/);
  assert.match(prompt, /Every clarification MUST include all of these fields: "id", "type",\s+"question", "businessImpact", and "resolved"/);
  assert.match(prompt, /"name":"originSearch","value":"Abu Dhabi"/);
  assert.match(prompt, /"id":"CL-001","type":"missing-validation","question":.+?"businessImpact":.+?"resolved":false/);
});

test("planner prompt requires story-linked, sequential test case IDs", () => {
  const prompt = buildPlannerPrompt(JSON.stringify({
    storyId: "AIT-8",
    title: "Passenger management",
    acceptanceCriteria: [{ id: "AC-1", description: "Select a cabin." }],
  }));
  assert.match(prompt, /<storyId>-TC-001, <storyId>-TC-002/);
  assert.match(prompt, /AIT-8-TC-001/);
  assert.match(prompt, /Keep the plan's storyId exactly equal to the requirement's storyId/);
});

test("links plan case IDs to the requirement story ID deterministically", () => {
  const plan = TestPlanSchema.parse({
    storyId: "AI-returned-id",
    title: "Passenger management",
    testCases: [
      { id: "TC-001", title: "First case", type: "positive", priority: "high", objective: "Check first.", expectedOutcome: "First passes." },
      { id: "AIT-8-TC-002", title: "Second case", type: "negative", priority: "medium", objective: "Check second.", expectedOutcome: "Second is rejected." },
    ],
  });

  const linked = linkTestCaseIdsToStory(plan, "AIT-8");
  assert.equal(linked.storyId, "AIT-8");
  assert.deepEqual(linked.testCases.map(testCase => testCase.id), [
    "AIT-8-TC-001",
    "AIT-8-TC-002",
  ]);
});

test("keeps test case IDs unchanged when the requirement has no story ID", () => {
  const plan = TestPlanSchema.parse({
    storyId: "AI-returned-id",
    title: "Unlinked story",
    testCases: [
      { id: "TC-001", title: "Case", type: "positive", priority: "low", objective: "Check it.", expectedOutcome: "It passes." },
    ],
  });

  assert.equal(linkTestCaseIdsToStory(plan).testCases[0].id, "TC-001");
});
