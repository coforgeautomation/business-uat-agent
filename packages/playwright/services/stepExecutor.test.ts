import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaywrightMcpClient } from "../mcp/playwrightMcpClient.js";
import { LocatorResolutionError } from "./locatorResolver.js";
import { executePlan } from "./stepExecutor.js";

test("asserts a passenger count from the textbox inside its labeled row", async () => {
  const browser = {
    callTool: async () => ({
      content: [{ type: "text", text: [
        '- generic [ref=row-adults]:',
        '  - generic [ref=label-adults]: Adults',
        '  - tab "-" [disabled] [ref=minus-adults]',
        '  - paragraph [ref=count-adults]:',
        '    - textbox: "1"',
        '  - tab "+" [ref=plus-adults]',
        '- generic [ref=row-infants]:',
        '  - generic [ref=label-infants]: Infants',
        '  - textbox: "0"',
      ].join("\n") }],
    }),
  } as unknown as PlaywrightMcpClient;
  const plan = (expected: string) => ({
    testCaseId: "TC-001",
    steps: [{
      id: "S1",
      sourceStep: `Verify Adults value equals ${expected}`,
      action: "assertValue",
      target: "Adults",
      expected,
    }],
  });

  const passed = await executePlan({ plan: plan("1"), browser });
  const failed = await executePlan({ plan: plan("2"), browser });

  assert.equal(passed[0].status, "passed");
  assert.match(passed[0].detail, /Adults value is '1'/);
  assert.equal(failed[0].status, "failed");
  assert.match(failed[0].detail, /received '1'/);
});

test("asserts a disabled passenger control even when the snapshot has no temporary ref", async () => {
  const browser = {
    callTool: async () => ({
      content: [{ type: "text", text: [
        '- generic [ref=row-adults]:',
        '  - generic [ref=label-adults]: Adults',
        '  - tab "-" [disabled]',
        '  - textbox: "1"',
        '  - tab "+" [ref=plus-adults]',
      ].join("\n") }],
    }),
  } as unknown as PlaywrightMcpClient;
  const result = await executePlan({
    plan: {
      testCaseId: "TC-001",
      steps: [{
        id: "S1",
        sourceStep: "Verify Decrease adults is disabled",
        action: "assertDisabled",
        target: "Decrease adults",
      }],
    },
    browser,
  });

  assert.equal(result[0].status, "passed");
  assert.match(result[0].detail, /Decrease adults is disabled/);
});

test("asserts that a forbidden results-page route was not opened", async () => {
  const browser = {
    callTool: async () => ({
      content: [{ type: "text", text: "Page URL: https://example.test/booking" }],
    }),
  } as unknown as PlaywrightMcpClient;
  const result = await executePlan({
    plan: {
      testCaseId: "AIT-8-TC-009",
      steps: [{
        id: "S1",
        sourceStep: "Verify page navigation is not Search Results Page",
        action: "assertUrlNot",
        expected: "search-results",
      }],
    },
    browser,
  });

  assert.equal(result[0].status, "passed");
  assert.match(result[0].detail, /does not contain 'search-results'/);

  const navigatedToResults = await executePlan({
    plan: {
      testCaseId: "AIT-8-TC-009",
      steps: [{
        id: "S1",
        sourceStep: "Verify page navigation is not Search Results Page",
        action: "assertUrlNot",
        expected: "search-results",
      }],
    },
    browser: {
      callTool: async () => ({
        content: [{ type: "text", text: "Page URL: https://example.test/search-results" }],
      }),
    } as unknown as PlaywrightMcpClient,
  });
  assert.equal(navigatedToResults[0].status, "failed");
});

test("MCP planner retries locator discovery without changing the approved action", async () => {
  const originalAttempts = process.env.MAX_HEAL_ATTEMPTS;
  const originalPlannerAttempts = process.env.MCP_PLANNER_RECOVERY_ATTEMPTS;
  process.env.MAX_HEAL_ATTEMPTS = "0";
  process.env.MCP_PLANNER_RECOVERY_ATTEMPTS = "2";
  const snapshots = [
    '- button "Search" [ref=search]',
    '- button "Search flights" [ref=search-flights]',
    '- button "Search flights" [ref=search-flights]',
  ];
  const clickedTargets: string[] = [];
  let appliedTarget = "";
  const browser = {
    callTool: async (name: string, args?: Record<string, unknown>) => {
      if (name === "browser_click") clickedTargets.push(String(args?.target));
      const text = name === "browser_snapshot" ? snapshots.shift() ?? '- button "Search flights" [ref=search-flights]' : "";
      return { content: [{ type: "text", text }] };
    },
  } as unknown as PlaywrightMcpClient;
  let resolveCalls = 0;
  const resolver = {
    resolve: async ({ target }: { target: string }) => {
      resolveCalls += 1;
      if (resolveCalls === 1) throw new LocatorResolutionError("Target was ambiguous.");
      assert.equal(target, "Search flights");
      return {
        key: "locator-key",
        descriptor: { strategy: "role", role: "button", value: "Search flights", exact: true },
        mcpRef: "search-flights",
        reused: false,
        evidence: "Unique button in the current snapshot.",
      };
    },
  } as never;

  try {
    const result = await executePlan({
      plan: {
        testCaseId: "TC-001",
        steps: [{ id: "S1", sourceStep: "Click Search", action: "click", target: "Search" }],
      },
      browser,
      resolver,
      onMcpPlannerRecovery: async (step, snapshot, failure, attempt, limit) => {
        assert.equal(step.target, "Search");
        assert.match(snapshot, /Search flights/);
        assert.match(failure, /Target was ambiguous/);
        assert.equal(attempt, 1);
        assert.equal(limit, 2);
        return {
          step: { ...step, target: "Search flights" },
          reason: "The snapshot identifies one matching button.",
        };
      },
      onPlanStepApplied: (_original, effective) => {
        appliedTarget = effective.target ?? "";
      },
    });

    assert.equal(result[0].status, "passed");
    assert.equal(result[0].recoveryReason, "The snapshot identifies one matching button.");
    assert.deepEqual(clickedTargets, ["search-flights"]);
    assert.equal(appliedTarget, "Search flights");
    assert.equal(resolveCalls, 2);
  } finally {
    if (originalAttempts === undefined) delete process.env.MAX_HEAL_ATTEMPTS;
    else process.env.MAX_HEAL_ATTEMPTS = originalAttempts;
    if (originalPlannerAttempts === undefined) delete process.env.MCP_PLANNER_RECOVERY_ATTEMPTS;
    else process.env.MCP_PLANNER_RECOVERY_ATTEMPTS = originalPlannerAttempts;
  }
});

test("assertText checks the requested element subtree instead of matching unrelated page text", async () => {
  const snapshot = [
    '- region "Search results" [ref=results]',
    '  - heading "Flights" [ref=flights]',
    '- contentinfo "Footer" [ref=footer]',
    '  - heading "Flights" [ref=footer-flights]',
  ].join("\n");
  const browser = {
    callTool: async () => ({ content: [{ type: "text", text: snapshot }] }),
  } as unknown as PlaywrightMcpClient;
  const resolver = {
    resolve: async () => ({
      key: "results-locator",
      descriptor: { strategy: "role", role: "region", value: "Search results", exact: true },
      mcpRef: "results",
      reused: false,
      evidence: "Unique results region in the live snapshot.",
    }),
  } as never;
  const plan = {
    testCaseId: "TC-RESULTS",
    steps: [{
      id: "S1",
      sourceStep: "Verify Search results contains text Flights",
      action: "assertText",
      target: "Search results",
      expected: "Flights",
    }],
  };

  const passed = await executePlan({ plan, browser, resolver });
  assert.equal(passed[0].status, "passed");

  const wrongExpectedText = await executePlan({
    plan: { ...plan, steps: [{ ...plan.steps[0], expected: "Economy" }] },
    browser,
    resolver,
  });
  assert.equal(wrongExpectedText[0].status, "failed");
  assert.match(wrongExpectedText[0].detail, /Search results.*contain text 'Economy'/);
});

test("assertSelected recognizes aria-checked state from MCP snapshots", async () => {
  const browser = {
    callTool: async () => ({
      content: [{ type: "text", text: '- radio "Business" [aria-checked="true"] [ref=business]' }],
    }),
  } as unknown as PlaywrightMcpClient;
  const resolver = {
    resolve: async () => ({
      key: "business-cabin",
      descriptor: { strategy: "role", role: "radio", value: "Business", exact: true },
      mcpRef: "business",
      reused: false,
      evidence: "Unique selected radio in the live snapshot.",
    }),
  } as never;
  const result = await executePlan({
    plan: {
      testCaseId: "TC-CABIN",
      steps: [{
        id: "S1",
        sourceStep: "Verify Business is selected",
        action: "assertSelected",
        target: "Business",
      }],
    },
    browser,
    resolver,
  });

  assert.equal(result[0].status, "passed");
});
