import { AIProvider } from "../providers/AIProvider";
import { Requirement, RequirementSchema } from "../../domain/schemas/requirement.schema";
import { TestPlan, TestPlanSchema, TestCase } from "../../domain/schemas/test-plan.schema";
import { buildPlannerPrompt } from "../prompts/planner.prompt";
import { StructuredResponseService } from "./structured-response.service";

import fs from "fs/promises";
import path from "path";
import { ExecutionPlanSchema } from "@domain/schemas/executionPlan.schema";
import {
  buildTypedActionPlan,
  normalizeApplicationNavigation,
  validatePlanActionIntents,
} from "./typedActionPlan.js";

export class PlannerService {
  constructor(
    private readonly provider: AIProvider,
    private readonly structuredResponse: StructuredResponseService,
  ) {}

  async createPlan(requirementInput: Requirement): Promise<TestPlan> {
    const requirement = RequirementSchema.parse(requirementInput);
    const domainContext = await this.readDomainContext();
    const prompt = buildPlannerPrompt(
      JSON.stringify(requirement, null, 2),
      domainContext,
    );
    const response = await this.provider.chat([
      {
        role: "system",
        content:"You are a senior web testing architect. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ]);

    const plan = await this.structuredResponse.parse(response, TestPlanSchema);
    const storyLinkedPlan = linkTestCaseIdsToStory(plan, requirement.storyId);
    // Keep the legacy top-level summary synchronized with structured coverage data.
    return {
      ...storyLinkedPlan,
      coverageSummary: storyLinkedPlan.coverageSummary || storyLinkedPlan.coverage?.coverageSummary || "",
    };
  }

  private async readDomainContext(): Promise<string> {
    return fs.readFile(
      path.join(process.cwd(), "packages", "domain", "context", "etihad-context.md"),
      "utf8",
    );
  }

  async makeTypedPlan(testCase: TestCase, storyId?: string) {
    try {
      return ExecutionPlanSchema.parse(buildTypedActionPlan(testCase, storyId));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("No deterministic action mapping")) throw error;
    }
    const masked = maskTestData(testCase);
    const response = await this.provider.chat([
        { role: "system", content: `Convert the supplied UI test case into a JSON action plan. Return exactly {"testCaseId":"...","storyId":"...","steps":[{"id":"S1","sourceStep":"original step","action":"navigate|click|fill|press|waitForLoad|waitForText|assertVisible|assertHidden|assertEnabled|assertDisabled|assertSelected|assertUnselected|assertValue|assertText|assertUrl|assertUrlNot|noOp","target":"semantic UI target when needed","value":"URL or literal value when needed","valueRef":"test_data name for sensitive or reusable values","expected":"expected assertion value"}]}. Preserve every supplied step in order and copy its sourceStep exactly. The source step defines the action type: Open application=navigate with the configured application URL in value (never a valueRef); Click or Select suggestion=click; Enter=fill; Verify ... is visible/not visible/enabled/disabled/selected/not selected/value equals/contains text maps to the matching assert action; Verify page navigation is not <page name>=assertUrlNot. Never turn a verification step into an interaction or an interaction into an assertion. Keep assertion intent, target, and expected value separate; do not add a different assertion merely to make the plan pass. If a verification cannot be represented without changing its meaning, return a planning error rather than guessing. For Etihad use Flying from/Flying to for Origin/Destination. Use waitForLoad for page readiness, not waitForText. Airport suggestion waits must expect the entered value, never a test_data key. Use literal expected values for assertValue. Add expectedOutcome assertions only when an observable assertion can be derived without changing meaning; otherwise rely on the explicit verification steps. Do not create selectors or code. Use valueRef for reusable test data in fill steps. Omit optional fields when they do not apply; do not emit empty strings.` },
        { role: "user", content: JSON.stringify({ storyId, testCase: masked.testCase }) },
      ],);
    const parsed = await this.structuredResponse.parse(
      response,
      ExecutionPlanSchema,
      normalizeApplicationNavigation,
    );
    const restored = ExecutionPlanSchema.parse(restoreTestDataMarkers(parsed, masked.values));
    validatePlanActionIntents(restored, testCase);
    return restored;
  }


}

export function linkTestCaseIdsToStory<T extends TestPlan>(
  plan: T,
  storyId?: string,
): T {
  const resolvedStoryId = storyId?.trim() || plan.storyId;
  const prefix = storyId?.trim();
  return {
    ...plan,
    storyId: resolvedStoryId,
    testCases: plan.testCases.map((testCase, index) => ({
      ...testCase,
      id: prefix
        ? `${prefix}-TC-${String(index + 1).padStart(3, "0")}`
        : testCase.id,
    })),
  };
}

function maskTestData(testCase: TestCase) {
  const values = (testCase.test_data ?? []).map((item, index) => ({
    name: item.name,
    value: String(item.value),
    marker: `__UAT_TEST_DATA_${index}__`,
  })).sort((left, right) => right.value.length - left.value.length);
  const masked = replaceStrings(testCase, values);
  masked.test_data = (testCase.test_data ?? []).map((item, index) => ({
    ...item,
    value: values.find(value => value.name === item.name)?.marker ?? `__UAT_TEST_DATA_${index}__`,
  }));
  return { testCase: masked, values };
}

function replaceStrings<T>(value: T, replacements: Array<{ value: string; marker: string }>): T {
  if (typeof value === "string") {
    let result: string = value;
    for (const item of replacements) {
      if (item.value) result = result.split(item.value).join(item.marker);
    }
    return result as T;
  }
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, replacements)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)])) as T;
  }
  return value;
}

function restoreTestDataMarkers<T>(value: T, replacements: Array<{ value: string; marker: string }>): T {
  if (typeof value === "string") {
    let result: string = value;
    for (const item of replacements) result = result.split(item.marker).join(item.value);
    return result as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => restoreTestDataMarkers(item, replacements)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreTestDataMarkers(item, replacements)])) as T;
  }
  return value;
}
