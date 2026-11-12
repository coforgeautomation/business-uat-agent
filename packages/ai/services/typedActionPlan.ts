import type { TestCase } from "../../domain/schemas/test-plan.schema.js";
import { getApplicationBaseUrl } from "../../playwright/config/applicationConfig.js";

type PlannedAction = {
  id: string;
  sourceStep: string;
  action: string;
  target?: string;
  value?: string;
  valueRef?: string;
  expected?: string;
};

export function buildTypedActionPlan(testCase: TestCase, storyId?: string) {
  const steps = testCase.steps.map((sourceStep, index) => compileStep(sourceStep, testCase, index));
  appendOutcomeAssertions(steps, testCase);
  return {
    testCaseId: testCase.id,
    storyId,
    steps: steps.map((step, index) => ({ ...step, id: `S${index + 1}` })),
  };
}

export function validatePlanActionIntents(
  plan: { steps: Array<{ sourceStep: string; action: string }> },
  testCase: TestCase,
): void {
  for (const approvedStep of testCase.steps) {
    const expectedAction = explicitStepAction(approvedStep);
    if (!expectedAction) continue;
    const plannedStep = plan.steps.find(step =>
      normalizeStep(step.sourceStep) === normalizeStep(approvedStep),
    );
    if (!plannedStep) {
      throw new Error(`Action plan omitted approved step: ${approvedStep}`);
    }
    if (plannedStep.action !== expectedAction) {
      throw new Error(
        `Action type mismatch for approved step "${approvedStep}": expected ${expectedAction}, received ${plannedStep.action}`,
      );
    }
  }
}

function explicitStepAction(sourceStep: string): string | undefined {
  if (/^Open application$/i.test(sourceStep)) return "navigate";
  if (/^Click\s+.+$/i.test(sourceStep)) return "click";
  if (/^Enter\s+.+\s+in\s+.+$/i.test(sourceStep)) return "fill";
  if (/^Select\s+.+\s+from\s+.+\s+suggestions?$/i.test(sourceStep)) return "click";
  if (/^Do not select any .+ suggestion$/i.test(sourceStep)) return "noOp";
  if (/^Verify\s+.+\s+is not visible$/i.test(sourceStep)) return "assertHidden";
  if (/^Verify page navigation is not .+$/i.test(sourceStep)) return "assertUrlNot";
  if (/^Verify\s+.+\s+is visible$/i.test(sourceStep)) return "assertVisible";
  if (/^Verify\s+.+\s+is not selected$/i.test(sourceStep)) return "assertUnselected";
  if (/^Verify\s+.+\s+is selected$/i.test(sourceStep)) return "assertSelected";
  if (/^Verify\s+.+\s+is disabled$/i.test(sourceStep)) return "assertDisabled";
  if (/^Verify\s+.+\s+is enabled$/i.test(sourceStep)) return "assertEnabled";
  if (/^Verify\s+.+\s+value equals(?:\s|$)/i.test(sourceStep)) return "assertValue";
  if (/^Verify\s+.+\s+contains text\s+.+$/i.test(sourceStep)) return "assertText";
  return undefined;
}

function normalizeStep(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function compileStep(sourceStep: string, testCase: TestCase, index: number): PlannedAction {
  const fieldStep = sourceStep.match(/^Enter\s+(.+?)\s+in\s+(Origin|Destination)(?:\s+field)?$/i);
  if (fieldStep) {
    const field = fieldStep[2].toLowerCase();
    const enteredValue = fieldStep[1].trim();
    const valueRef = dataKey(testCase, enteredValue) ?? dataKey(testCase, field);
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "fill",
      target: field === "origin" ? "Flying from" : "Flying to",
      ...(valueRef ? { valueRef } : { value: enteredValue }),
    };
  }

  if (/^Do not select any (?:Origin|Destination) suggestion$/i.test(sourceStep)) {
    return { id: `S${index + 1}`, sourceStep, action: "noOp" };
  }
  if (/^Wait for page load$/i.test(sourceStep)) {
    return { id: `S${index + 1}`, sourceStep, action: "waitForLoad" };
  }
  if (/^Wait for airport suggestions$/i.test(sourceStep)) {
    const previousAirportEntry = [...testCase.steps.slice(0, index)].reverse()
      .map(step => step.match(/^Enter\s+(.+?)\s+in\s+(Origin|Destination)(?:\s+field)?$/i))
      .find((match): match is RegExpMatchArray => match !== null);
    if (!previousAirportEntry) {
      throw new Error(`No deterministic action mapping for approved step ${index + 1}: ${sourceStep}`);
    }

    const enteredValue = previousAirportEntry[1].trim();
    const field = previousAirportEntry[2].toLowerCase();
    const valueRef = dataKey(testCase, enteredValue) ?? dataKey(testCase, field);
    const expected = valueRef ? dataValue(testCase, valueRef) : enteredValue;
    if (expected === undefined || expected === null || String(expected).trim() === "") {
      throw new Error(`No deterministic action mapping for approved step ${index + 1}: ${sourceStep}`);
    }
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "waitForText",
      target: "Airport suggestions",
      expected: String(expected),
    };
  }
  const suggestionStep = sourceStep.match(
    /^Select\s+(?:suggestion matching\s+)?(.+?)\s+from\s+(?:(Origin|Destination)\s+)?(?:airport\s+)?suggestions?$/i,
  );
  if (suggestionStep) {
    const suggestedValue = suggestionStep[1].trim();
    const field = suggestionStep[2]?.toLowerCase()
      ?? precedingAirportField(testCase.steps, index);
    const valueRef = testCase.test_data?.find(item =>
      String(item.value).toLocaleLowerCase() === suggestedValue.toLocaleLowerCase(),
    )?.name ?? (field ? dataKey(testCase, `${field} suggestion`) : undefined);
    const expected = valueRef ? dataValue(testCase, valueRef) : suggestedValue;
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "click",
      target: `Airport suggestions: ${String(expected ?? suggestedValue)}`,
      ...(valueRef ? { valueRef } : {}),
    };
  }
  if (/^Open application$/i.test(sourceStep)) {
    return { id: `S${index + 1}`, sourceStep, action: "navigate", value: getApplicationBaseUrl() };
  }

  const click = sourceStep.match(/^Click\s+(.+?)\.?$/i);
  if (click) {
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "click",
      target: canonicalTarget(click[1], testCase),
    };
  }

  const disabled = sourceStep.match(/^Verify\s+(.+?)\s+is disabled$/i);
  if (disabled) {
    return { id: `S${index + 1}`, sourceStep, action: "assertDisabled", target: canonicalTarget(disabled[1], testCase) };
  }
  const enabled = sourceStep.match(/^Verify\s+(.+?)\s+is enabled$/i);
  if (enabled) {
    return { id: `S${index + 1}`, sourceStep, action: "assertEnabled", target: canonicalTarget(enabled[1], testCase) };
  }
  const hidden = sourceStep.match(/^Verify\s+(.+?)\s+is not visible$/i);
  if (hidden) {
    return { id: `S${index + 1}`, sourceStep, action: "assertHidden", target: canonicalTarget(hidden[1], testCase) };
  }
  const visible = sourceStep.match(/^Verify\s+(.+?)\s+is visible$/i);
  if (visible) {
    return { id: `S${index + 1}`, sourceStep, action: "assertVisible", target: canonicalTarget(visible[1], testCase) };
  }
  const unselected = sourceStep.match(/^Verify\s+(.+?)\s+is not selected$/i);
  if (unselected) {
    return { id: `S${index + 1}`, sourceStep, action: "assertUnselected", target: canonicalTarget(unselected[1], testCase) };
  }
  const selected = sourceStep.match(/^Verify\s+(.+?)\s+is selected$/i);
  if (selected) {
    return { id: `S${index + 1}`, sourceStep, action: "assertSelected", target: canonicalTarget(selected[1], testCase) };
  }
  const containsText = sourceStep.match(/^Verify\s+(.+?)\s+contains text\s+(.+)$/i);
  if (containsText) {
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "assertText",
      target: canonicalTarget(containsText[1], testCase),
      expected: containsText[2].trim(),
    };
  }
  const value = sourceStep.match(/^Verify\s+(.+?)\s+value equals\s*(.*)$/i);
  if (value) {
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "assertValue",
      target: canonicalTarget(value[1], testCase),
      expected: value[2].trim(),
    };
  }
  const valueEquals = sourceStep.match(/^Verify value\s+(.+?)\s+equals\s+(.+)$/i);
  if (valueEquals) {
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "assertValue",
      target: canonicalTarget(valueEquals[1], testCase),
      expected: valueEquals[2].trim(),
    };
  }
  const pageNavigation = sourceStep.match(/^Verify page navigation is not (.+)$/i);
  if (pageNavigation) {
    return {
      id: `S${index + 1}`,
      sourceStep,
      action: "assertUrlNot",
      expected: pageNavigation[1]
        .replace(/\s+Page$/i, "")
        .trim()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase(),
    };
  }
  throw new Error(`No deterministic action mapping for approved step ${index + 1}: ${sourceStep}`);
}

function appendOutcomeAssertions(steps: PlannedAction[], testCase: TestCase) {
  const outcome = testCase.expectedOutcome.toLowerCase();
  const add = (action: string, target: string, expected?: string) => {
    if (steps.some(step => step.action === action && step.target?.toLowerCase() === target.toLowerCase())) return;
    steps.push({ id: "", sourceStep: testCase.expectedOutcome, action, target, expected });
  };

  if (/round trip.*default|default.*round trip/i.test(outcome)) add("assertSelected", "Round Trip");
  if (/select one way/i.test(outcome)) add("assertSelected", "One Way");
  if (/select multi city/i.test(outcome)) add("assertVisible", "Flight 1");
  if (/guides?.*origin|complete origin/i.test(outcome)) add("assertVisible", "Flying from");
  if (/guides?.*destination|complete destination/i.test(outcome)) add("assertVisible", "Flying to");
  if (/popular destination/i.test(outcome)) add("assertVisible", "Popular destinations");
  if (/airport code/i.test(outcome)) addValueOutcome(steps, testCase, add, "Origin", /origin/i);
  if (/airport name/i.test(outcome)) addValueOutcome(steps, testCase, add, "Destination", /destination.*name/i);
  if (/city name/i.test(outcome)) addValueOutcome(steps, testCase, add, "Destination", /destination.*city/i);
  if (/not shown as a selectable option|not shown.*suggestions|not.*selectable option/i.test(outcome)) {
    const airport = testCase.test_data?.find(item => /airport/i.test(item.name));
    add("assertHidden", String(airport?.value ?? "Airport suggestions"));
  }
  if (/destination is cleared|destination.*cleared/i.test(outcome)) add("assertValue", "Destination", "");
  if (/flight listings?.*flight details|flight details.*visible/i.test(outcome)) add("assertVisible", "Flight details");
  if (/inputs are accessible|key inputs are accessible/i.test(outcome)) add("assertVisible", "Search");

  if (/economy.*default|default.*economy/i.test(outcome)) add("assertSelected", "Economy");
  if (/only one cabin class|only selected cabin class|only one selected cabin|single.select cabin/i.test(outcome)) {
    const selectedCabin = [...steps].reverse().find(step =>
      step.action === "click" && /^(Economy|Business|First)$/i.test(step.target ?? ""),
    )?.target;
    if (selectedCabin) {
      add("assertSelected", selectedCabin);
      for (const cabin of ["Economy", "Business", "First"]) {
        if (cabin.toLowerCase() !== selectedCabin.toLowerCase()) add("assertUnselected", cabin);
      }
    }
  }
  const requestedCabin = testCase.test_data?.find(item => /expected.?cabin/i.test(item.name));
  if (requestedCabin && /only one cabin|single cabin|no conflicting cabin/i.test(outcome)) {
    const selected = String(requestedCabin.value);
    add("assertSelected", selected);
    for (const cabin of ["Economy", "Business", "First"]) {
      if (cabin.toLowerCase() !== selected.toLowerCase()) add("assertUnselected", cabin);
    }
  }
  if (/adult.*(?:minimum|below 1)|adults below 1/i.test(outcome)) {
    const minimum = testCase.test_data?.find(item => /adult.*minimum/i.test(item.name));
    add("assertValue", "Adults");
    const last = steps[steps.length - 1];
    if (last.sourceStep === testCase.expectedOutcome && last.target === "Adults" && last.action === "assertValue") {
      last.expected = String(minimum?.value ?? 1);
    }
  }
  if (/infants? greater than adults|infant with seat greater than adults/i.test(outcome)) {
    const target = /infant with seat/i.test(outcome) ? "Increase Infant With Seat" : "Increase infants";
    add("assertDisabled", target);
  }
  if (/occupied seats.*(?:9|nine)|maximum.*9/i.test(outcome)) {
    const maximum = testCase.test_data?.find(item => /occupiedseat/i.test(item.name));
    add("assertValue", "Adults");
    const last = steps[steps.length - 1];
    if (last.sourceStep === testCase.expectedOutcome && last.target === "Adults" && last.action === "assertValue") {
      last.expected = String(maximum?.value ?? 9);
    }
    add("assertDisabled", "Increase adults");
  }
  if (/until both origin and destination|until valid airports|guests\s*&\s*cabin remains blocked|cannot open guests/i.test(outcome)) {
    add("assertHidden", "Guests & Cabin");
  }
  if (/does not proceed with search|prevents further increases.*search|does not proceed/i.test(outcome)) {
    add("assertVisible", "Guests & Cabin");
  }
}

function addValueOutcome(
  steps: PlannedAction[],
  testCase: TestCase,
  add: (action: string, target: string, expected?: string) => void,
  target: string,
  dataName: RegExp,
) {
  const value = testCase.test_data?.find(item => dataName.test(item.name))?.value;
  const enteredValue = value === undefined
    ? [...steps].reverse().find(step => step.action === "fill" && step.target === (target === "Origin" ? "Flying from" : "Flying to"))?.value
    : String(value);
  if (enteredValue !== undefined) add("assertValue", target, enteredValue);
}

function canonicalTarget(target: string, testCase: TestCase): string {
  const normalized = target.replace(/[?.:]+$/g, "").trim();
  if (/^(origin|flying from)(?: field)?$/i.test(normalized)) return "Flying from";
  if (/^(destination|flying to)(?: field)?$/i.test(normalized)) return "Flying to";
  if (/^(guests|passengers)\s*&\s*cabin$/i.test(normalized)) return "Guests & Cabin";
  const cabin = normalized.match(/^(?:selected option\s+)?(Economy|Business|First)(?:\s+cabin)?(?:\s+radio button)?$/i);
  if (cabin) return cabin[1];
  const passengerControl = normalized.match(/^(?:selected option\s+)?(increase|decrease)\s+(adults?|children|infants?|infant with seat)(?:\s+control)?$/i);
  if (passengerControl) {
    const group = passengerControl[2].replace(/^adult$/i, "Adults")
      .replace(/^child$/i, "Children")
      .replace(/^children$/i, "Children")
      .replace(/^infant$/i, "Infants")
      .replace(/^infants$/i, "Infants")
      .replace(/^infant with seat$/i, "Infant With Seat");
    const direction = passengerControl[1].toLowerCase() === "increase" ? "Increase" : "Decrease";
    return `${direction} ${group}`;
  }
  const passengerCount = normalized.match(/^(?:selected option\s+)?(adult|adults|adult passenger count|child|children|child passenger count|infant|infants|infant passenger count|infant with seat)(?:\s+value)?$/i);
  if (passengerCount) {
    const passenger = passengerCount[1].toLowerCase();
    if (passenger.startsWith("adult")) return "Adults";
    if (passenger.startsWith("child")) return "Children";
    return passenger.includes("seat") ? "Infants with Seat" : "Infants";
  }
  const data = testCase.test_data ?? [];
  if (/^(Business|Economy|First)$/i.test(normalized)) return normalized;
  if (/increase|decrease|search/i.test(normalized)) return normalized;
  const testDataMatch = data.find(item => String(item.value).toLowerCase() === normalized.toLowerCase());
  return testDataMatch ? String(testDataMatch.value) : normalized;
}

function precedingAirportField(steps: string[], index: number): string | undefined {
  for (const step of steps.slice(0, index).reverse()) {
    const entry = step.match(/^Enter\s+.+?\s+in\s+(Origin|Destination)(?:\s+field)?$/i);
    if (entry) return entry[1].toLowerCase();
  }
  return undefined;
}

function dataKey(testCase: TestCase, reference: string): string | undefined {
  const normalizedReference = normalizeDataKey(reference);
  const exactMatch = testCase.test_data?.find(item =>
    normalizeDataKey(item.name) === normalizedReference,
  );
  if (exactMatch) return exactMatch.name;

  const aliases: Record<string, string[]> = {
    origin: ["origin", "origincity", "originsearch", "originsuggestion", "from", "fromcity"],
    destination: ["destination", "destinationcity", "destinationsearch", "destinationsuggestion", "to", "tocity"],
  };
  const names = aliases[normalizedReference] ?? [normalizedReference];
  return testCase.test_data?.find(item =>
    names.includes(normalizeDataKey(item.name)),
  )?.name;
}

function normalizeDataKey(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function dataValue(testCase: TestCase, key: string): string | number | boolean | undefined {
  return testCase.test_data?.find(item => item.name === key)?.value;
}

export function normalizeApplicationNavigation(plan: unknown): unknown {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) return plan;
  const applicationUrl = getApplicationBaseUrl();
  return {
    ...plan,
    steps: plan.steps.map(step => {
      if (!isRecord(step)
          || step.sourceStep !== "Open application"
          || step.action !== "navigate") return step;
      const { valueRef: _valueRef, ...navigation } = step;
      return { ...navigation, value: applicationUrl };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
