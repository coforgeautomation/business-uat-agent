import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionPlan } from "../schemas/actionPlan.schema.js";
import type { LocatorDescriptor } from "../schemas/locator.schema.js";
import {
  repairGeneratedTestStep,
  renderPlaywrightTest,
  stepsRequiringExploration,
  type TestGenerationInput,
} from "./testCodeGenerator.js";

test("repairs only the failed step block in an existing generated spec", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "generated-test-repair-"));
  const file = path.join(directory, "TC-001.spec.ts");
  try {
    const baseInput = createInput({
      strategy: "text",
      value: "Search",
      exact: true,
    });
    const before = `// Generated for TC-001; replay status is recorded separately.\n${renderPlaywrightTest(baseInput)}\n`;
    await writeFile(file, before, "utf8");

    const repairedInput = createInput({
      strategy: "role",
      role: "button",
      value: "Search",
      exact: true,
    });
    await repairGeneratedTestStep(repairedInput, file, "S2");
    const after = await readFile(file, "utf8");

    assert.equal(stepBlock(after, "S1"), stepBlock(before, "S1"));
    assert.notEqual(stepBlock(after, "S2"), stepBlock(before, "S2"));
    assert.match(stepBlock(after, "S2"), /"role":"button"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wraps every approved step in a Playwright business-step event", () => {
  const source = renderPlaywrightTest(createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  }));
  assert.match(source, /await test\.step\("S1: Open application"/);
  assert.match(source, /await test\.step\("S2: Click Search"/);
});

test("generates a negative URL assertion without changing the approved navigation intent", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testCase.steps = [
    "Open application",
    "Verify page navigation is not Search Results Page",
  ];
  input.actionPlan.steps[1] = {
    id: "S2",
    sourceStep: input.testCase.steps[1],
    action: "assertUrlNot",
    expected: "search-results",
  };
  input.verifiedLocators = [];

  assert.match(
    renderPlaywrightTest(input),
    /expect\(page\)\.not\.toHaveURL\(new RegExp\("search-results", "i"\)\)/,
  );
  assert.deepEqual(stepsRequiringExploration(input), []);
});

test("uses a matching generated step body and identifies unsupported steps for exploration", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.reusableSteps = new Map([["click search", "await flightSearch.searchButton.click();"]]);

  const source = renderPlaywrightTest(input);
  assert.match(source, /\n    await flightSearch\.searchButton\.click\(\);/);
  assert.doesNotMatch(source, /common\.click\(flightSearch\.searchButton\)/);
  assert.deepEqual(stepsRequiringExploration(input), []);

  input.reusableSteps.clear();
  input.verifiedLocators = [];
  input.actionPlan.steps[1].target = "Unsupported control";
  assert.match(stepsRequiringExploration(input)[0], /^S2: .*no supported, verified locator/);
});

test("uses the journey-type page object for journey-type visibility assertions", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testCase.steps = ["Open application", "Verify Round Trip is visible"];
  input.actionPlan.steps[1] = {
    id: "S2",
    sourceStep: "Verify Round Trip is visible",
    action: "assertVisible",
    target: "Round Trip",
  };

  assert.match(renderPlaywrightTest(input), /common\.expectVisible\(flightSearch\.journeyTypeLocator\("roundTrip"\)\)/);
});

test("uses the shared travel-date page object without requiring MCP locator discovery", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testData = { departureDate: "2026-12-10" };
  input.testCase.steps = ["Open application", "Click Departure date", "Click 2026-12-10"];
  input.actionPlan.steps = [
    input.actionPlan.steps[0],
    {
      id: "S2",
      sourceStep: "Click Departure date",
      action: "click",
      target: "Departure date",
    },
    {
      id: "S3",
      sourceStep: "Click 2026-12-10",
      action: "click",
      target: "2026-12-10",
      valueRef: "departureDate",
    },
  ];
  input.verifiedLocators = [];

  const source = renderPlaywrightTest(input);
  assert.match(source, /flightSearch\.openTravelDates\(\)/);
  assert.match(source, /flightSearch\.selectTravelDate\(requireTestData\("departureDate"\)\)/);
  assert.deepEqual(stepsRequiringExploration(input), []);
});

test("targets the requested flight leg when a multi-city plan repeats airport fields", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testData = { origin: "Abu Dhabi" };
  input.testCase.steps = ["Open application", "Enter Abu Dhabi in Origin of Flight 2"];
  input.actionPlan.steps = [
    input.actionPlan.steps[0],
    {
      id: "S2",
      sourceStep: input.testCase.steps[1],
      action: "fill",
      target: "Flight 2 Origin",
      valueRef: "origin",
    },
  ];
  input.verifiedLocators = [];

  const source = renderPlaywrightTest(input);
  assert.match(source, /flightSearch\.fillAirport\("origin", requireTestData\("origin"\), 2\)/);
  assert.deepEqual(stepsRequiringExploration(input), []);
});

test("selects the matching airport suggestion for the same multi-city leg", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testData = { destinationQuery: "London", destinationSuggestion: "London Heathrow Airport" };
  input.testCase.steps = [
    "Open application",
    "Enter London in Flight 2 Destination",
    "Select airport suggestion for London",
  ];
  input.actionPlan.steps = [
    input.actionPlan.steps[0],
    {
      id: "S2",
      sourceStep: input.testCase.steps[1],
      action: "fill",
      target: "Flight 2 Destination",
      valueRef: "destinationQuery",
    },
    {
      id: "S3",
      sourceStep: input.testCase.steps[2],
      action: "click",
      target: "Airport suggestion",
      expected: "London Heathrow",
      valueRef: "destinationSuggestion",
    },
  ];
  input.verifiedLocators = [];

  const source = renderPlaywrightTest(input);
  assert.match(source, /flightSearch\.fillAirport\("destination", requireTestData\("destinationQuery"\), 2\)/);
  assert.match(source, /flightSearch\.selectAirportSuggestion\("destination", requireTestData\("destinationSuggestion"\), 2\)/);
  assert.deepEqual(stepsRequiringExploration(input), []);
});

test("reuses the Etihad guests, cabin, passenger, and search page-object actions", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testCase.steps = [
    "Open application",
    "Click Guests and Cabin",
    "Click Business",
    "Click Increase Adults",
    "Click Search",
  ];
  input.actionPlan.steps = [
    input.actionPlan.steps[0],
    { id: "S2", sourceStep: input.testCase.steps[1], action: "click", target: "Guests and Cabin" },
    { id: "S3", sourceStep: input.testCase.steps[2], action: "click", target: "Business" },
    { id: "S4", sourceStep: input.testCase.steps[3], action: "click", target: "Increase Adults" },
    { id: "S5", sourceStep: input.testCase.steps[4], action: "click", target: "Search" },
  ];
  input.verifiedLocators = [];

  const source = renderPlaywrightTest(input);
  assert.match(source, /flightSearch\.openGuestsCabin\(\)/);
  assert.match(source, /flightSearch\.selectCabin\("Business"\)/);
  assert.match(source, /flightSearch\.changePassengerCount\("Adults", "increase"\)/);
  assert.match(source, /flightSearch\.submitSearch\(\)/);
  assert.deepEqual(stepsRequiringExploration(input), []);
});

test("allows test data in descriptive step titles while keeping executable values environment-backed", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testData = { originQuery: "Heathrow" };
  input.actionPlan.steps[1] = {
    id: "S2",
    sourceStep: "Enter Heathrow in Flying from",
    action: "fill",
    target: "Flying from",
    valueRef: "originQuery",
  };
  input.testCase.steps[1] = "Enter Heathrow in Flying from";

  const source = renderPlaywrightTest(input);
  assert.match(source, /test\.step\("S2: Enter Heathrow in Flying from"/);
  assert.match(source, /flightSearch\.fillAirport\("origin", requireTestData\("originQuery"\)\)/);
});

test("reuses the destination page-object field for empty-value outcome assertions", () => {
  const input = createInput({
    strategy: "text",
    value: "Search",
    exact: true,
  });
  input.testCase.steps[1] = "Verify Destination value equals";
  input.actionPlan.steps[1] = {
    id: "S2",
    sourceStep: "Verify Destination value equals",
    action: "assertValue",
    target: "Destination",
    expected: "",
  };

  assert.match(renderPlaywrightTest(input), /common\.expectValue\(flightSearch\.destination, ""\)/);
});

test("generates text assertions against the requested element, not the whole page", () => {
  const input = createInput({
    strategy: "role",
    role: "region",
    value: "Search results",
    exact: true,
  });
  input.testCase.steps[1] = "Verify Search results contains text Flights";
  input.actionPlan.steps[1] = {
    id: "S2",
    sourceStep: input.testCase.steps[1],
    action: "assertText",
    target: "Search results",
    expected: "Flights",
  };
  input.verifiedLocators[0].sourceStep = input.testCase.steps[1];

  const source = renderPlaywrightTest(input);
  assert.match(source, /common\.expectContainsText\(common\.locator\(/);
  assert.match(source, /"value":"Search results"/);
  assert.match(source, /"Flights"\)/);
  assert.doesNotMatch(source, /page\.getByText\("Flights"/);
});

function createInput(locator: LocatorDescriptor): TestGenerationInput {
  return {
    storyId: "AIT-8",
    actionPlan: {
      testCaseId: "TC-001",
      storyId: "AIT-8",
      steps: [
        {
          id: "S1",
          sourceStep: "Open application",
          action: "navigate",
          value: "https://example.test/",
        },
        {
          id: "S2",
          sourceStep: "Click Search",
          action: "click",
          target: "Search flight",
        },
      ],
    } satisfies ExecutionPlan,
    testCase: {
      id: "TC-001",
      title: "Search button is available",
      steps: ["Open application", "Click Search"],
    },
    testData: {},
    verifiedLocators: [{
      stepId: "S2",
      sourceStep: "Click Search",
      locator,
    }],
  };
}

function stepBlock(source: string, stepId: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(`  // ${stepId}`);
  assert.notEqual(start, -1);
  let end = start + 1;
  while (end < lines.length && !/^  \/\/ S\d+$/.test(lines[end]) && !/^\}\);$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}
