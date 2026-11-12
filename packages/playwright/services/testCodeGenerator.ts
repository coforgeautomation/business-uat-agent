import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, PlannedStep } from "../schemas/actionPlan.schema.js";
import type { LocatorDescriptor } from "../schemas/locator.schema.js";

export type TestGenerationInput = {
  storyId?: string;
  actionPlan: ExecutionPlan;
  testCase: { id: string; title: string; expectedOutcome?: string; steps: string[] };
  testData: Record<string, unknown>;
  verifiedLocators: Array<{ stepId: string; sourceStep: string; locator: LocatorDescriptor; evidence?: string }>;
  reusableSteps?: Map<string, string>;
  locatorOverrideStepIds?: string[];
};

export class GeneratedStepRepairUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedStepRepairUnavailableError";
  }
}

/** Creates a replayable Playwright spec from the approved case and validated action plan. */
export async function generateTestFile(input: TestGenerationInput) {
  const source = renderPlaywrightTest(input);
  validateGeneratedSource(source, input);

  const file = generatedTestFilePath(input.storyId, input.testCase.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `// Generated for ${input.testCase.id}; replay status is recorded separately.\n${source}\n`, "utf8");
  return file;
}

export function generatedTestFilePath(storyId: string | undefined, testCaseId: string): string {
  const safeStory = safeName(storyId ?? "unassigned-story");
  const safeCase = safeName(testCaseId);
  const root = path.resolve(__dirname, "../../..");
  return path.join(root, "packages/playwright/tests/generated", safeStory, `${safeCase}.spec.ts`);
}

/** Replaces exactly one generated step block after MCP has verified its repaired locator. */
export async function repairGeneratedTestStep(input: TestGenerationInput, file: string, stepId: string): Promise<string> {
  const repairInput = { ...input, locatorOverrideStepIds: [stepId] };
  const candidate = renderPlaywrightTest(repairInput);
  validateGeneratedSource(candidate, repairInput);
  const existing = await readFile(file, "utf8");
  const updated = replaceGeneratedStep(existing, candidate, stepId);
  await writeFile(file, updated, "utf8");
  return file;
}

function replaceGeneratedStep(existing: string, candidate: string, stepId: string): string {
  const marker = `  // ${stepId}`;
  const existingLines = existing.split(/\r?\n/);
  const candidateLines = candidate.split(/\r?\n/);
  const findMarker = (lines: string[]) => lines.flatMap((line, index) => line === marker ? [index] : []);
  const existingMarkers = findMarker(existingLines);
  const candidateMarkers = findMarker(candidateLines);
  if (existingMarkers.length !== 1 || candidateMarkers.length !== 1) {
    throw new GeneratedStepRepairUnavailableError(`Cannot safely repair ${stepId}: expected one matching step marker in both test files`);
  }
  const findBlockEnd = (lines: string[], start: number) => {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^  \/\/ S\d+$/.test(lines[index]) || /^\}\);$/.test(lines[index])) return index;
    }
    throw new GeneratedStepRepairUnavailableError(`Cannot safely repair ${stepId}: generated step block has no boundary`);
  };
  const existingStart = existingMarkers[0];
  const candidateStart = candidateMarkers[0];
  const existingEnd = findBlockEnd(existingLines, existingStart);
  const candidateEnd = findBlockEnd(candidateLines, candidateStart);
  const replacement = candidateLines.slice(candidateStart, candidateEnd);
  existingLines.splice(existingStart, existingEnd - existingStart, ...replacement);
  return existingLines.join("\n");
}

export function renderPlaywrightTest(input: TestGenerationInput) {
  const { actionPlan, testCase, testData } = input;
  const lines = [
    'import { test, expect } from "@playwright/test";',
    'import { CommonPage } from "../../../pages/CommonPage.js";',
    'import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";',
    'import { requireTestData } from "../../../test-data/runtimeTestData.js";',
    "",
    `test(${JSON.stringify(testCase.id)}, async ({ page }) => {`,
    "  const common = new CommonPage(page);",
    "  const flightSearch = new FlightSearchPage(page);",
    "",
  ];
  let activeAirportField: { field: "origin" | "destination"; leg: number } | undefined;
  for (const [stepIndex, step] of actionPlan.steps.entries()) {
    lines.push(`  // ${step.id}`);
    const reusableBody = input.reusableSteps?.get(normalizeStep(step.sourceStep));
    const stepLines = reusableBody !== undefined
      ? reusableBody.split("\n")
      : renderStep(step, input, actionPlan.steps[stepIndex + 1]);
    if (reusableBody === undefined && step.action === "click" && isAirportSuggestionTarget(step.target ?? "")) {
      if (!activeAirportField) throw new Error(`${step.id}: airport suggestion selection has no preceding airport field`);
      const leg = activeAirportField.leg === 1 ? "" : `, ${activeAirportField.leg}`;
      const suggestion = step.expected ?? step.value;
      const selection = suggestion
        ? `selectAirportSuggestion(${JSON.stringify(activeAirportField.field)}, ${valueExpression(suggestion, step.valueRef, input.testData)}${leg})`
        : `selectFirstAirportSuggestion(${JSON.stringify(activeAirportField.field)}${leg})`;
      stepLines.push(`  await flightSearch.${selection};`);
    }
    lines.push(`  await test.step(${JSON.stringify(`${step.id}: ${step.sourceStep}`)}, async () => {`);
    const bodyIndent = reusableBody === undefined ? "  " : "    ";
    lines.push(...stepLines.map(line => line ? `${bodyIndent}${line}` : ""));
    lines.push("  });", "");
    if (step.action === "fill") {
      const field = fieldName(step.target);
      activeAirportField = field ? { field, leg: flightLegNumber(step) } : undefined;
    }
  }
  lines.push("});");
  return lines.join("\n");
}

export function stepsRequiringExploration(input: TestGenerationInput): string[] {
  const missing: string[] = [];
  for (const [index, step] of input.actionPlan.steps.entries()) {
    if (input.reusableSteps?.has(normalizeStep(step.sourceStep))) continue;
    try {
      renderStep(step, input, input.actionPlan.steps[index + 1]);
    } catch (error) {
      missing.push(`${step.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return missing;
}

function renderStep(
  step: PlannedStep,
  input: TestGenerationInput,
  nextStep?: PlannedStep,
) {
  const locatorOverride = renderVerifiedLocatorOverride(step, input);
  if (locatorOverride) return locatorOverride;
  if (step.action === "noOp") return [];
  if (step.action === "navigate") return [`  await page.goto(${JSON.stringify(step.value)}, { waitUntil: "domcontentloaded" });`, ""];
  if (step.action === "waitForLoad") {
    const url = input.actionPlan.steps.find(item => item.action === "navigate")?.value;
    if (!url) throw new Error(`${step.id}: cannot verify page load because the plan has no navigation URL`);
    if (input.actionPlan.steps.some(item => fieldName(item.target))) {
      return [`  await flightSearch.waitUntilReady(${JSON.stringify(url)});`, ""];
    }
    return [`  await expect(page).toHaveURL(${JSON.stringify(url)});`, ""];
  }
  if (step.action === "waitForText" && /airport suggestions?/i.test(step.sourceStep)) {
    return [`  await flightSearch.waitForAirportSuggestions(${valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "waitForText") {
    return [`  await expect(page.getByText(${valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData)})).toBeVisible();`, ""];
  }
  if (step.action === "fill") {
    const field = fieldName(step.target);
    if (field) {
      const leg = flightLegNumber(step);
      const legArgument = leg === 1 ? "" : `, ${leg}`;
      return [`  await flightSearch.fillAirport(${JSON.stringify(field)}, ${valueExpression(step.value ?? "", step.valueRef, input.testData)}${legArgument});`, ""];
    }
    return [`  await common.fill(${locatorExpression(step, input)}, ${valueExpression(step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "click" && isAirportSuggestionTarget(step.target ?? "")) return [];
  if (step.action === "click" && isJourneyTypeTarget(step.target ?? "")) {
    return [`  await flightSearch.selectJourneyType(${JSON.stringify(journeyTypeName(step.target ?? ""))});`, ""];
  }
  if (step.action === "click" && isTravelDateTarget(step.target ?? "")) {
    return [`  await flightSearch.openTravelDates();`, ""];
  }
  if (step.action === "click" && isTravelDateValue(step.target ?? step.value ?? "")) {
    return [`  await flightSearch.selectTravelDate(${valueExpression(step.target ?? step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "click" && isGuestsCabinTarget(step.target ?? "")) {
    return [`  await flightSearch.openGuestsCabin();`, ""];
  }
  if (step.action === "click" && isCabinTarget(step.target ?? "")) {
    return [`  await flightSearch.selectCabin(${JSON.stringify((step.target ?? "").trim())});`, ""];
  }
  if (step.action === "click") {
    const passengerControl = passengerControlDetails(step.target ?? "");
    if (passengerControl) {
      return [`  await flightSearch.changePassengerCount(${JSON.stringify(passengerControl.group)}, ${JSON.stringify(passengerControl.direction)});`, ""];
    }
    if (isSearchTarget(step.target ?? "")) return [`  await flightSearch.submitSearch();`, ""];
  }
  if (step.action === "click" && nextStep?.action === "assertHidden"
      && (nextStep.target ?? "").toLowerCase() === (step.target ?? "").toLowerCase()) {
    return [`  await common.clickIfPresent(page.getByText(${valueExpression(step.target ?? "", step.valueRef, input.testData)}, { exact: true }));`, ""];
  }
  if (step.action === "click") return [`  await common.click(${locatorExpression(step, input)});`, ""];
  if (step.action === "press") return [`  await common.press(${locatorExpression(step, input)}, ${JSON.stringify(step.value ?? "Enter")});`, ""];
  if (step.action === "assertValue") {
    return [`  await common.expectValue(${locatorExpression(step, input)}, ${valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "assertVisible") {
    return [`  await common.expectVisible(${visibleLocatorExpression(step, input)});`, ""];
  }
  if (step.action === "assertText") {
    const expected = step.expected ?? step.value ?? step.target ?? "";
    return [`  await common.expectContainsText(${locatorExpression(step, input)}, ${valueExpression(expected, step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "assertUrl") {
    return [`  await expect(page).toHaveURL(${JSON.stringify(step.expected ?? step.value)});`, ""];
  }
  if (step.action === "assertUrlNot") {
    const expected = step.expected ?? step.value ?? "";
    return [`  await expect(page).not.toHaveURL(new RegExp(${JSON.stringify(escapeRegExp(expected))}, "i"));`, ""];
  }
  if (step.action === "assertHidden") {
    if (isGuestsCabinTarget(step.target ?? "")) {
      return [`  await flightSearch.expectGuestsCabinPanelHidden();`, ""];
    }
    return [`  await common.expectHidden(page.getByText(${valueExpression(step.target ?? "", step.valueRef, input.testData)}, { exact: true }));`, ""];
  }
  if (step.action === "assertEnabled") return [`  await common.expectEnabled(${locatorExpression(step, input)});`, ""];
  if (step.action === "assertDisabled") return [`  await common.expectDisabled(${locatorExpression(step, input)});`, ""];
  if (step.action === "assertSelected") return [`  await common.expectSelected(${locatorExpression(step, input)});`, ""];
  if (step.action === "assertUnselected") return [`  await common.expectUnselected(${locatorExpression(step, input)});`, ""];
  if (step.action === "waitForLoad") return [];
  throw new Error(`${step.id}: unsupported generated action '${step.action}'`);
}

function renderVerifiedLocatorOverride(step: PlannedStep, input: TestGenerationInput): string[] | undefined {
  if (!input.locatorOverrideStepIds?.includes(step.id)) return undefined;
  const evidence = input.verifiedLocators.find(item => item.stepId === step.id);
  if (!evidence) throw new Error(`${step.id}: locator repair was requested without a verified locator`);
  const locator = `common.locator(${JSON.stringify(evidence.locator)})`;
  if (step.action === "click") return [`  await common.click(${locator});`, ""];
  if (step.action === "fill") {
    return [`  await common.fill(${locator}, ${valueExpression(step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "press") return [`  await common.press(${locator}, ${JSON.stringify(step.value ?? "Enter")});`, ""];
  if (step.action === "assertValue") {
    return [`  await common.expectValue(${locator}, ${valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData)});`, ""];
  }
  if (step.action === "assertVisible") return [`  await common.expectVisible(${locator});`, ""];
  if (step.action === "assertHidden") return [`  await common.expectHidden(${locator});`, ""];
  if (step.action === "assertEnabled") return [`  await common.expectEnabled(${locator});`, ""];
  if (step.action === "assertDisabled") return [`  await common.expectDisabled(${locator});`, ""];
  if (step.action === "assertSelected") return [`  await common.expectSelected(${locator});`, ""];
  if (step.action === "assertUnselected") return [`  await common.expectUnselected(${locator});`, ""];
  return undefined;
}

function locatorExpression(step: PlannedStep, input: TestGenerationInput) {
  const target = step.target ?? step.locatorKey ?? "";
  const field = fieldName(target);
  if (field) return airportFieldExpression(step, field);
  if (isSearchTarget(target)) return "flightSearch.searchButton";
  if (isGuestsCabinTarget(target)) return "flightSearch.guestsCabinTile";
  if (isJourneyTypeTarget(target)) {
    return `flightSearch.journeyTypeLocator(${JSON.stringify(journeyTypeName(target))})`;
  }
  if (isCabinTarget(target)) {
    return `flightSearch.cabinOption(${valueExpression(target, undefined, input.testData)})`;
  }
  if (step.action === "assertValue") {
    const passengerGroup = passengerGroupName(target);
    if (passengerGroup) return `flightSearch.passengerCount(${JSON.stringify(passengerGroup)})`;
  }
  const passengerControl = passengerControlDetails(target);
  if (passengerControl) {
    return `flightSearch.passengerControl(${JSON.stringify(passengerControl.group)}, ${JSON.stringify(passengerControl.direction)})`;
  }
  const evidence = input.verifiedLocators.find(item => item.sourceStep === step.sourceStep)?.locator;
  if (evidence) return `common.locator(${JSON.stringify(evidence)})`;
  throw new Error(`${step.id}: no supported, verified locator for '${target}'`);
}

function visibleLocatorExpression(step: PlannedStep, input: TestGenerationInput) {
  const target = step.target ?? step.locatorKey ?? "";
  if (isGuestsCabinTarget(target)) return "flightSearch.guestsCabinTile";
  if (isJourneyTypeTarget(target)) {
    return `flightSearch.journeyTypeLocator(${JSON.stringify(journeyTypeName(target))})`;
  }
  if (isCabinTarget(target)) {
    return `flightSearch.cabinOption(${valueExpression(target, undefined, input.testData)})`;
  }
  const field = fieldName(target);
  if (field) return airportFieldExpression(step, field);
  if (step.expected || step.value) {
    const expected = valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData);
    return `page.getByText(${expected}, { exact: true })`;
  }
  return `page.getByText(${JSON.stringify(target)}, { exact: true })`;
}

function passengerGroupName(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "youngadults") return "Young Adults";
  if (normalized.startsWith("adult")) return "Adults";
  if (normalized === "children" || normalized === "child") return "Children";
  if (normalized.startsWith("infant") && normalized.includes("seat")) return "Infants with Seat";
  if (normalized.startsWith("infant")) return "Infants";
  return undefined;
}

function passengerControlDetails(
  target: string,
): { group: string; direction: "increase" | "decrease" } | undefined {
  const control = target.match(/^(increase|decrease)\s+(young\s+adults?|adults?|children|infants?(?:\s+with\s+seat)?)$/i);
  if (!control) return undefined;
  const group = passengerGroupName(control[2]);
  const direction = control[1].toLowerCase();
  if (!group || (direction !== "increase" && direction !== "decrease")) return undefined;
  return { group, direction };
}

function isCabinTarget(target: string) {
  return /^(Economy|Business|First)$/i.test(target.trim());
}

function isSearchTarget(target: string) {
  return /^search(?: flight)?$/i.test(target.trim());
}

function isJourneyTypeTarget(target: string) {
  const normalized = target.toLocaleLowerCase();
  return normalized.includes("one-way") || normalized.includes("one way")
    || normalized.includes("round trip") || normalized.includes("multi-city") || normalized.includes("multi city");
}

function isTravelDateTarget(target: string) {
  return /^(departure|return|travel) dates?$/i.test(target.trim());
}

function isTravelDateValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function fieldName(target?: string): "origin" | "destination" | undefined {
  const normalized = target?.trim().toLocaleLowerCase()
    .replace(/\b(?:flight|leg)\s*#?\s*\d+\b/g, " ")
    .replace(/\b(?:for|of)\b/g, " ")
    .replace(/\s+field\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "flying from" || normalized === "from" || normalized === "origin") return "origin";
  if (normalized === "flying to" || normalized === "to" || normalized === "destination") return "destination";
  return undefined;
}

function flightLegNumber(step: PlannedStep): number {
  const description = `${step.target ?? ""} ${step.sourceStep}`;
  const numberedLeg = description.match(/\b(?:flight|leg)\s*#?\s*(\d+)\b/i);
  if (numberedLeg) return Number(numberedLeg[1]);
  const ordinalLeg = description.match(/\b(first|second|third)\s+(?:flight|leg)\b/i)?.[1]?.toLowerCase();
  if (ordinalLeg === "second") return 2;
  if (ordinalLeg === "third") return 3;
  return 1;
}

function airportFieldExpression(step: PlannedStep, field: "origin" | "destination"): string {
  const leg = flightLegNumber(step);
  return leg === 1
    ? `flightSearch.${field}`
    : `flightSearch.airportFieldForLeg(${JSON.stringify(field)}, ${leg})`;
}

function journeyTypeName(target: string): "oneWay" | "roundTrip" | "multiCity" {
  const normalized = target.toLocaleLowerCase().replace(/[-\s]/g, "");
  if (normalized.includes("oneway")) return "oneWay";
  if (normalized.includes("multicity")) return "multiCity";
  return "roundTrip";
}

function valueExpression(value: string, valueRef: string | undefined, testData: Record<string, unknown>) {
  const dataName = valueRef
    ? valueRef
    : Object.keys(testData).find(name => String(testData[name]) === value);
  if (dataName) {
    if (!Object.hasOwn(testData, dataName)) throw new Error(`Missing generated test data value '${dataName}'`);
    return `requireTestData(${JSON.stringify(dataName)})`;
  }
  if (valueRef) throw new Error(`Missing generated test data value '${valueRef}'`);
  return JSON.stringify(value);
}

function isAirportSuggestionTarget(target: string) {
  return /airport suggestions?/i.test(target);
}

function isGuestsCabinTarget(target: string) {
  return ["guestsandcabin", "passengersandcabin"].includes(target.toLocaleLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, ""));
}

function validateGeneratedSource(source: string, input: TestGenerationInput) {
  const caseId = input.testCase.id;
  if (!source.includes("@playwright/test") || !/\btest\s*\(/.test(source)) throw new Error(`Generator returned invalid Playwright test for ${caseId}`);
  if (!source.includes(caseId)) throw new Error(`Generated test does not identify approved case ${caseId}`);
  const requiredAssertions = input.actionPlan.steps.filter(step =>
    step.action.startsWith("assert") && !input.locatorOverrideStepIds?.includes(step.id),
  );
  const generatedAssertions = source.match(/await (?:expect\(|common\.expect(?:Visible|Hidden|Enabled|Disabled|Value|Selected|Unselected)\(|flightSearch\.expectGuestsCabinPanelHidden\()/g)?.length ?? 0;
  if (generatedAssertions < requiredAssertions.length) throw new Error(`Generated test omitted one or more approved assertions for ${caseId}`);
  for (const step of requiredAssertions.filter(item => item.action === "assertValue")) {
    const expected = valueExpression(step.expected ?? step.value ?? "", step.valueRef, input.testData);
    const assertion = `await common.expectValue(${locatorExpression(step, input)}, ${expected});`;
    if (!source.includes(assertion)) throw new Error(`Generated test omitted approved value assertion ${step.id}`);
  }
  const executableSource = source.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith("//") && !/await test\.step\(/.test(line))
    .join("\n");
  for (const value of Object.values(input.testData).filter((item): item is string => typeof item === "string" && item.length > 3)) {
    if (executableSource.includes(value)) throw new Error("Generated test must load test data from environment variables, not embed values");
  }
  if (/\.(?:first|last|nth)\s*\(/.test(source)) throw new Error("Generated test uses a positional locator to hide ambiguity");
  if (/browser_run_code_unsafe|child_process|process\.exit|eval\s*\(/.test(source)) throw new Error("Generated test contains a disallowed execution primitive");
}
function safeName(value: string) { return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "case"; }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeStep(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.,!?;:]+$/g, "").toLocaleLowerCase();
}
