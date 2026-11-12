import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMcpBrowserConfig } from "../../playwright/config/browserProfile.js";
import { PlannerService } from "@ai/services/planner.service.js";
import { AIProvider } from "@ai/providers/AIProvider.js";
import { StructuredResponseService } from "@ai/services/structured-response.service";
import { PlaywrightMcpClient } from "../../playwright/mcp/playwrightMcpClient";
import {executePlan,type StepResult,} from "../../playwright/services/stepExecutor";
import {
  GeneratedStepRepairUnavailableError,
  stepsRequiringExploration,
  generateTestFile,
  repairGeneratedTestStep,
} from "../../playwright/services/testCodeGenerator";
import { replayGeneratedTest, type ReplayResult } from "../../playwright/services/testReplay";
import { proposeRepair } from "../../playwright/services/healer";
import { getLocatorMetrics } from "../../playwright/services/locatorMetrics";
import { LocatorRegistry } from "../../playwright/registry/locatorRegistry.js";
import { LocatorResolver } from "../../playwright/services/locatorResolver.js";
import { McpExecutionPlanner } from "../../playwright/services/mcpExecutionPlanner.js";
import { validatePlanActionIntents } from "../../ai/services/typedActionPlan.js";
import { clearExecutionRedactions, recordExecutionEvent, redactExecutionData, setExecutionRedactions } from "../../playwright/services/executionHistory.js";
import type { TestCase } from "../../domain/schemas/test-plan.schema";
import type { ExecutionStatus } from "../../domain/src/testPlan";
import { transition } from "./executionStateMachine.js";
import { casesForStory, findStory, readApprovedPlan } from "./planReader.js";
import { findReusableGeneratedTest, findReusableStepImplementations } from "./generatedTestReuse.js";
import {
  checkpointFromProgress,
  getScriptMetadata,
  saveExecutionCheckpoint,
  updateScriptMetadata,
} from "../../playwright/services/automationRepository.js";

type TestStory = { id?: string; title?: string };
export type CaseGenerationStage =
  | "queued"
  | "planning"
  | "exploring"
  | "discovering_locators"
  | "generating_script"
  | "validating_script"
  | "saving_script"
  | "completed"
  | "failed"
  | "blocked";

export type CaseProgressUpdate = {
  phase: "planning" | "executing" | "finished";
  stage?: CaseGenerationStage;
  currentStep: number;
  totalSteps: number;
  activeStepId?: string;
  currentAction?: string;
  currentUrl?: string;
  locatorsFound?: number;
  confidence?: number;
  errorReason?: string;
  plannedSteps: string[];
  steps: StepResult[];
  observation?: string;
};
export type CaseProgressCallback = (update: CaseProgressUpdate) => void | Promise<void>;
type ExecutionOutcome = {
  executionId: string;
  storyId?: string;
  testCaseId: string;
  title: string;
  expectedResult: string;
  testData: Array<{ name: string; value: string }>;
  status: ExecutionStatus;
  plan?: unknown;
  steps: StepResult[];
  generatedTest?: string;
  testSource?: "reused" | "healed" | "generated";
  reuseAttempt?: ReplayResult;
  retryAttempt?: ReplayResult;
  recovery?: Record<string, unknown>;
  replay?: unknown;
  healer?: unknown;
  error?: string;
  locatorMetrics?: unknown;
  screenshot?: string;
  screenshotError?: string;
  failureType?: "application" | "automation";
  artifacts?: Record<string, string>;
};

export async function executeApprovedCase(
  testCaseId: string,
  planPath = "output/sprint-plan.json",
  onProgress?: CaseProgressCallback,
  options: { regenerateScript?: boolean; storyId?: string; jobExecutionId?: string } = {},
) {
  const approvedPlan = await readApprovedPlan(planPath);
  const stories = options.storyId
    ? [findStory(approvedPlan, options.storyId)].filter((story): story is NonNullable<typeof story> => Boolean(story))
    : approvedPlan.stories;
  for (const story of stories) {
    const testCase = casesForStory(story).find(
      (candidate) => candidate.id === testCaseId,
    );
    if (testCase) return runCase(testCase, story, planPath, onProgress, options);
  }
  throw new Error(`Test case not found in ${planPath}: ${testCaseId}`);
}

export async function runCase(
  testCase: TestCase,
  story: TestStory,
  planPath = "output/sprint-plan.json",
  onProgress?: CaseProgressCallback,
  options: { regenerateScript?: boolean; storyId?: string; jobExecutionId?: string } = {},
): Promise<ExecutionOutcome> {
  const executionId = randomUUID();
  const checkpointExecutionId = options.jobExecutionId ?? executionId;
  const root = path.resolve(__dirname, "../../..");
  const outputDir = path.join(root, "output/automation/executions", executionId);
  await mkdir(outputDir, { recursive: true });
  const testData = Object.fromEntries(
    (testCase.test_data ?? []).map((item) => [item.name, item.value]),
  );
  setExecutionRedactions(executionId, Object.values(testData));
  let status: ExecutionStatus = "queued";
  const steps: StepResult[] = [];
  let browser: PlaywrightMcpClient | undefined;
  let resolver: LocatorResolver | undefined;
  const artifacts: Record<string, string> = {
    result: path.join(outputDir, "result.json"),
    history: path.join(outputDir, "history.jsonl"),
    metrics: path.join(outputDir, "metrics.json"),
  };
  const outcome: ExecutionOutcome = {
    executionId,
    storyId: story.id,
    testCaseId: testCase.id,
    title: testCase.title,
    expectedResult: testCase.expectedOutcome,
    testData: (testCase.test_data ?? []).map(({ name }) => ({ name, value: "[REDACTED]" })),
    status,
    steps,
    artifacts,
  };
  const startedAt = new Date().toISOString();
  const reportProgress = async (update: CaseProgressUpdate) => {
    const checkpoint = checkpointFromProgress({
      storyId: story.id ?? "unassigned-story",
      testCaseId: testCase.id,
      executionId: checkpointExecutionId,
      startedAt,
      ...update,
    });
    await saveExecutionCheckpoint(redactExecutionData(checkpoint, executionId));
    await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
      lastPassedStep: checkpoint.lastPassedStep,
    });
    await onProgress?.(update);
  };

  const move = async (
    next: ExecutionStatus,
    event: string,
    details?: unknown,
  ) => {
    status = transition(status, next);
    outcome.status = status;
    await recordExecutionEvent({
      executionId,
      storyId: story.id,
      testCaseId: testCase.id,
      status,
      event,
      details,
    });
  };

  await reportProgress({
    phase: "planning",
    stage: "planning",
    currentStep: 0,
    totalSteps: testCase.steps.length,
    plannedSteps: testCase.steps,
    steps: [],
    confidence: testCase.confidence,
    observation: redactExecutionData(`Planning ${testCase.id}: ${testCase.title}`, executionId) as string,
  });
  await recordExecutionEvent({
    executionId,
    storyId: story.id,
    testCaseId: testCase.id,
    status,
    event: "execution_created",
    details: { planPath },
  });
  try {
    await move("planning", "planning_started");
    const reusableTest = await findReusableGeneratedTest(story.id, testCase);
    const reusableFile = reusableTest && "file" in reusableTest ? reusableTest.file : undefined;
    const existingTestFile = options.regenerateScript ? undefined : reusableFile;
    if (reusableTest && "reason" in reusableTest) {
      await recordExecutionEvent({
        executionId,
        storyId: story.id,
        testCaseId: testCase.id,
        status,
        event: "existing_test_not_reusable",
        details: { reason: reusableTest.reason },
      });
    }
    if (existingTestFile && !options.regenerateScript) {
      outcome.generatedTest = existingTestFile;
      artifacts.generatedTest = existingTestFile;
      outcome.testSource = "reused";
      await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
        scriptPath: existingTestFile,
        status: "EXECUTING",
        lastExecutionAt: new Date().toISOString(),
      });
      await recordExecutionEvent({
        executionId,
        storyId: story.id,
        testCaseId: testCase.id,
        status,
        event: "existing_test_reuse_started",
        details: { file: existingTestFile },
      });
      await reportProgress({
        phase: "executing",
        currentStep: 0,
        totalSteps: testCase.steps.length,
        plannedSteps: testCase.steps,
        steps: [],
        observation: `Using Existing Playwright Script for ${testCase.id}`,
      });
      await move("replaying", "existing_test_replay_started", { file: existingTestFile });
      const firstReplay = await replayGeneratedTest({
        file: existingTestFile,
        executionId,
        approvedAssertionTexts: [testCase.expectedOutcome],
        approvedOptionNames: [],
        testData,
        attemptName: "reuse",
        onStepProgress: replayProgressCallback(testCase.steps, onProgress),
      });
      outcome.reuseAttempt = firstReplay;
      let reuseReplay = firstReplay;
      if (firstReplay.artifacts) {
        for (const [name, file] of Object.entries(firstReplay.artifacts)) artifacts[`reuse${capitalize(name)}`] = file;
      }
      if (firstReplay.status !== "passed") {
        await recordExecutionEvent({
          executionId,
          storyId: story.id,
          testCaseId: testCase.id,
          status,
          event: "existing_test_reuse_failed",
          details: {
            file: existingTestFile,
            status: firstReplay.status,
            failedStepId: firstReplay.failedStepId,
            failureType: firstReplay.failureType,
          },
        });
        await move("planning", "existing_test_retry_started", {
          file: existingTestFile,
          failedStepId: firstReplay.failedStepId,
        });
        await reportProgress({
          phase: "planning",
          currentStep: 0,
          totalSteps: testCase.steps.length,
          plannedSteps: testCase.steps,
          steps: replayStepResults(testCase.steps, firstReplay),
          observation: `Retrying existing Playwright script after ${firstReplay.status}`,
        });
        await move("replaying", "existing_test_retry_started", { file: existingTestFile });
        reuseReplay = await replayGeneratedTest({
          file: existingTestFile,
          executionId,
          approvedAssertionTexts: [testCase.expectedOutcome],
          approvedOptionNames: [],
          testData,
          attemptName: "reuse-retry",
          onStepProgress: replayProgressCallback(testCase.steps, onProgress),
        });
        outcome.retryAttempt = reuseReplay;
        if (reuseReplay.artifacts) {
          for (const [name, file] of Object.entries(reuseReplay.artifacts)) artifacts[`retry${capitalize(name)}`] = file;
        }
      }
      if (reuseReplay.status === "passed") {
        outcome.replay = reuseReplay;
        if (outcome.retryAttempt) {
          outcome.recovery = {
            strategy: "retry-existing-script",
            initialReplayStatus: firstReplay.status,
            retryStatus: reuseReplay.status,
          };
        }
        outcome.steps = replayStepResults(testCase.steps, reuseReplay);
        artifacts.steps = path.join(outputDir, "steps.json");
        await writeFile(artifacts.steps, JSON.stringify(outcome.steps, null, 2));
        outcome.locatorMetrics = await getLocatorMetrics();
        await writeFile(artifacts.metrics, JSON.stringify(outcome.locatorMetrics, null, 2));
        await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
          scriptPath: existingTestFile,
          status: "PASSED",
          lastExecutionAt: new Date().toISOString(),
          lastPassedStep: testCase.steps.length,
        });
        await move("passed", "existing_test_reuse_passed", { file: existingTestFile });
        await reportProgress({
          phase: "finished",
          currentStep: testCase.steps.length,
          totalSteps: testCase.steps.length,
          plannedSteps: testCase.steps,
          steps: outcome.steps,
          observation: outcome.retryAttempt
            ? `Existing Playwright script retry passed for ${testCase.id}`
            : `Existing Playwright test passed for ${testCase.id}`,
        });
        const safeOutcome = redactExecutionData(outcome, executionId);
        await writeFile(artifacts.result, JSON.stringify(safeOutcome, null, 2));
        return safeOutcome;
      }
      outcome.steps = replayStepResults(testCase.steps, reuseReplay);
      outcome.replay = reuseReplay;
      outcome.failureType = reuseReplay.failureType ?? (reuseReplay.status === "failed" ? "application" : "automation");
      outcome.error = `Existing Playwright test ${reuseReplay.status} after one retry: ${reuseReplay.failureMessage ?? reuseReplay.stderr}`;
      const finalStatus: ExecutionStatus = reuseReplay.status === "failed" ? "failed" : "blocked";
      const passedSteps = outcome.steps.filter(step => step.status === "passed").length;
      outcome.recovery = {
        strategy: "retry-exhausted",
        initialReplayStatus: firstReplay.status,
        retryStatus: reuseReplay.status,
        failedStepId: reuseReplay.failedStepId,
      };
      await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
        scriptPath: existingTestFile,
        status: "NEEDS_HEALING",
        lastExecutionAt: new Date().toISOString(),
        lastPassedStep: passedSteps,
      });
      await move(finalStatus, "existing_test_retry_exhausted", {
        file: existingTestFile,
        failedStepId: reuseReplay.failedStepId,
        retryStatus: reuseReplay.status,
      });
      artifacts.steps = path.join(outputDir, "steps.json");
      await writeFile(artifacts.steps, JSON.stringify(redactExecutionData(outcome.steps, executionId), null, 2));
      outcome.locatorMetrics = await getLocatorMetrics();
      await writeFile(artifacts.metrics, JSON.stringify(outcome.locatorMetrics, null, 2));
      await reportProgress({
        phase: "finished",
        stage: finalStatus,
        currentStep: passedSteps,
        totalSteps: testCase.steps.length,
        plannedSteps: testCase.steps,
        steps: redactExecutionData(outcome.steps, executionId),
        errorReason: redactExecutionData(outcome.error, executionId) as string,
        observation: `Execution stopped after one retry. ${testCase.id} needs healing.`,
      });
      const safeOutcome = redactExecutionData(outcome, executionId);
      await writeFile(artifacts.result, JSON.stringify(safeOutcome, null, 2));
      return safeOutcome;
    }

    const provider = new AIProvider();
    const structuredResponse = new StructuredResponseService();
    const planner = new PlannerService(provider, structuredResponse);
    let plan = await makePlanWithRetry(planner, testCase, story.id, async (attempt, error) => {
      await reportProgress({
        phase: "planning",
        stage: "planning",
        currentStep: 0,
        totalSteps: testCase.steps.length,
        plannedSteps: testCase.steps,
        steps: [],
        confidence: testCase.confidence,
        observation: redactExecutionData(
          `Planning attempt ${attempt}/2 failed: ${error}. Retrying Planning`,
          executionId,
        ) as string,
      });
    });
    validatePlanForCase(plan, testCase);
    outcome.plan = plan;
    artifacts.plan = path.join(outputDir, "action-plan.json");
    await writeFile(artifacts.plan, JSON.stringify(redactExecutionData(plan, executionId), null, 2));

    const navigationUrl = plan.steps.find(step => step.action === "navigate")?.value;
    const reusableImplementations = await findReusableStepImplementations(
      testCase,
      navigationUrl,
      undefined,
      existingTestFile,
    );
    const reusableSteps = new Map(
      [...reusableImplementations].map(([key, implementation]) => [key, implementation.body]),
    );
    const implementationInput = {
      storyId: story.id,
      actionPlan: plan,
      testCase: {
        id: testCase.id,
        title: testCase.title,
        expectedOutcome: testCase.expectedOutcome,
        steps: testCase.steps,
      },
      testData,
      verifiedLocators: [],
      reusableSteps,
    };
    const explorationGaps = existingTestFile
      ? ["The existing case script failed replay; retry with MCP before reusing or regenerating its implementation"]
      : stepsRequiringExploration(implementationInput);
    const currentUrl = navigationUrl;
    await reportProgress({
      phase: "executing",
      stage: explorationGaps.length ? "exploring" : "generating_script",
      currentStep: 0,
      totalSteps: plan.steps.length,
      currentUrl,
      confidence: testCase.confidence,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: [],
      observation: explorationGaps.length
        ? `Planning Complete. Reusing ${reusableSteps.size} existing step implementations; exploring ${explorationGaps.length} missing step(s)`
        : `Planning Complete. Reusing existing Playwright/POM implementations for all ${plan.steps.length} steps; MCP exploration is not needed`,
    });

    await move("exploring", "step_implementation_reuse_checked", {
      reusedStepCount: reusableSteps.size,
      reusedSteps: [...reusableImplementations.values()].map(item => ({
        sourceStep: item.sourceStep,
        testCaseId: item.testCaseId,
        file: item.file,
      })),
      explorationGaps,
    });

    let runSteps: StepResult[];
    let planWasRecovered = false;
    if (explorationGaps.length === 0) {
      await move("executing", "reuse_completed_without_mcp", {
        reusedStepCount: reusableSteps.size,
        explorationGaps,
      });
      runSteps = [];
      await reportProgress({
        phase: "executing",
        stage: "generating_script",
        currentStep: 0,
        totalSteps: plan.steps.length,
        currentUrl,
        confidence: testCase.confidence,
        plannedSteps: plan.steps.map(step => step.sourceStep),
        steps: runSteps,
        observation: `All steps are covered by ${reusableSteps.size} matching generated implementations or existing shared POM actions; composing the script without MCP exploration`,
      });
    } else {
      const mcpConfigPath = await createIsolatedMcpConfig(outputDir);
      await recordExecutionEvent({
        executionId,
        storyId: story.id,
        testCaseId: testCase.id,
        status,
        event: "browser_starting",
        details: { headless: false, isolated: true, config: mcpConfigPath },
      });
      const activeBrowser = await connectMcpWithRetry(mcpConfigPath, executionId, story.id, testCase.id, async (attempt, error) => {
        await reportProgress({
          phase: "executing",
          stage: "exploring",
          currentStep: 0,
          totalSteps: plan.steps.length,
          plannedSteps: plan.steps.map(step => step.sourceStep),
          steps: [],
          confidence: testCase.confidence,
          observation: `MCP exploration connection attempt ${attempt}/3 failed: ${error}. Retrying exploration`,
        });
      });
      browser = activeBrowser;
      await move("executing", "steps_started", { count: plan.steps.length });
      resolver = new LocatorResolver();
      const mcpExecutionPlanner = new McpExecutionPlanner(provider);
      await reportProgress({
          phase: "executing",
          stage: "exploring",
          currentStep: 0,
          totalSteps: plan.steps.length,
          plannedSteps: plan.steps.map(step => step.sourceStep),
          steps: [],
          confidence: testCase.confidence,
          observation: existingTestFile ? "Retrying reusable script steps and discovering only missing locators to heal the existing script" : "Exploring only steps without reusable implementations",
      });
      runSteps = await executePlan({
          plan,
          browser: activeBrowser,
          testData,
          pageKey: story.id ?? "app-home",
          resolver,
          onMcpPlannerRecovery: async (step, snapshot, failure, attempt, limit) => {
            await reportProgress({
              phase: "executing",
              stage: "discovering_locators",
              currentStep: steps.length,
              totalSteps: plan.steps.length,
              activeStepId: step.id,
              currentAction: `MCP planner recovery ${attempt}/${limit}: ${step.sourceStep}`,
              currentUrl,
              locatorsFound: steps.filter(item => item.locatorKey).length,
              confidence: testCase.confidence,
              plannedSteps: plan.steps.map(item => item.sourceStep),
              steps: redactExecutionData(steps, executionId),
              observation: redactExecutionData(
                `MCP planner is using the live page snapshot to recover locator discovery after: ${failure}`,
                executionId,
              ) as string,
            });
            const decision = await mcpExecutionPlanner.suggestAlternateStep({
              testCase: {
                id: testCase.id,
                title: testCase.title,
                objective: testCase.objective,
                expectedOutcome: testCase.expectedOutcome,
              },
              step,
              snapshot: redactExecutionData(snapshot, executionId) as string,
              failure: redactExecutionData(failure, executionId) as string,
              attempt,
            });
            if ("blockedReason" in decision) {
              await reportProgress({
                phase: "executing",
                stage: "discovering_locators",
                currentStep: steps.length,
                totalSteps: plan.steps.length,
                activeStepId: step.id,
                currentAction: "MCP planner recovery blocked",
                currentUrl,
                locatorsFound: steps.filter(item => item.locatorKey).length,
                confidence: testCase.confidence,
                plannedSteps: plan.steps.map(item => item.sourceStep),
                steps: redactExecutionData(steps, executionId),
                errorReason: decision.blockedReason,
                observation: redactExecutionData(
                  `MCP planner could not safely recover ${step.id}: ${decision.blockedReason}`,
                  executionId,
                ) as string,
              });
              return decision;
            }
            return decision;
          },
          onPlanStepApplied: (originalStep, effectiveStep) => {
            plan.steps = plan.steps.map(item => item.id === originalStep.id ? effectiveStep : item);
            planWasRecovered = true;
          },
          onStepStart: async (step, completedSteps, totalSteps) => {
            await reportProgress({
              phase: "executing",
              stage: step.action === "navigate" ? "exploring" : "discovering_locators",
              currentStep: completedSteps,
              totalSteps,
              activeStepId: step.id,
              currentAction: step.sourceStep,
              currentUrl: step.action === "navigate" ? step.value : currentUrl,
              locatorsFound: steps.filter(item => item.locatorKey).length,
              confidence: testCase.confidence,
              plannedSteps: plan.steps.map(item => item.sourceStep),
              steps: redactExecutionData(steps, executionId),
              observation: `Executing: ${step.sourceStep}`,
            });
          },
          onLocatorDiscoveryRetry: async (step, attempt, limit, detail) => {
            await reportProgress({
              phase: "executing",
              stage: "discovering_locators",
              currentStep: steps.length,
              totalSteps: plan.steps.length,
              activeStepId: step.id,
              currentAction: `Ask Planner for alternate path · MCP re-discovery ${attempt}/${limit}`,
              currentUrl,
              locatorsFound: steps.filter(item => item.locatorKey).length,
              confidence: testCase.confidence,
              plannedSteps: plan.steps.map(item => item.sourceStep),
              steps: redactExecutionData(steps, executionId),
              observation: redactExecutionData(detail, executionId) as string,
            });
          },
          onStep: async (step, completedSteps, totalSteps) => {
            await reportProgress({
              phase: "executing",
              stage: step.locatorKey ? "discovering_locators" : "exploring",
              currentStep: completedSteps.length,
              totalSteps,
              activeStepId: undefined,
              currentAction: step.sourceStep,
              currentUrl,
              locatorsFound: completedSteps.filter(item => item.locatorKey).length,
              confidence: testCase.confidence,
              plannedSteps: plan.steps.map(item => item.sourceStep),
              steps: redactExecutionData(completedSteps, executionId),
              observation: redactExecutionData(
                `${step.status === "passed" ? "Verified" : step.status === "failed" ? "Failed" : "Blocked"}: ${step.sourceStep}`,
                executionId,
              ) as string,
            });
          },
      });
    }
    if (planWasRecovered) {
      await writeFile(artifacts.plan, JSON.stringify(redactExecutionData(plan, executionId), null, 2));
    }
    steps.push(...runSteps);
    outcome.steps = steps;
    artifacts.steps = path.join(outputDir, "steps.json");
    await writeFile(artifacts.steps, JSON.stringify(redactExecutionData(steps, executionId), null, 2));
    await recordExecutionEvent({
      executionId,
      storyId: story.id,
      testCaseId: testCase.id,
      status,
      event: "steps_finished",
      details: steps,
    });

    const failed = steps.find((step) => step.status !== "passed");
    if (failed) {
      const screenshot = path.join(outputDir, `failure-${failed.stepId}.png`);
      if (browser) {
        try {
          await browser.callTool("browser_take_screenshot", { filename: screenshot });
          outcome.screenshot = screenshot;
          await recordExecutionEvent({
            executionId,
            storyId: story.id,
            testCaseId: testCase.id,
            status,
            event: "failure_screenshot_captured",
            details: { file: screenshot, stepId: failed.stepId },
          });
        } catch (error) {
          outcome.screenshotError = error instanceof Error ? error.message : String(error);
          await recordExecutionEvent({
            executionId,
            storyId: story.id,
            testCaseId: testCase.id,
            status,
            event: "failure_screenshot_failed",
            details: { file: screenshot, error: outcome.screenshotError },
          });
        }
      } else {
        outcome.screenshotError = "No MCP browser was available to capture a screenshot";
        await recordExecutionEvent({
          executionId,
          storyId: story.id,
          testCaseId: testCase.id,
          status,
          event: "failure_screenshot_failed",
          details: { file: screenshot, error: outcome.screenshotError },
        });
      }
      outcome.failureType = failed.status === "failed" ? "application" : "automation";
      outcome.error = `Step ${failed.stepId} ${outcome.failureType} failure: ${failed.detail}`;
      const repair = await proposeRepair({
        failure: redactExecutionData(failed, executionId),
        evidence: { plan, steps: redactExecutionData(steps, executionId) },
        attempt: 0,
      });
      outcome.healer = { proposals: steps.flatMap(step => step.repairs ?? []), diagnosis: repair };
      await recordExecutionEvent({
        executionId,
        storyId: story.id,
        testCaseId: testCase.id,
        status,
        event: "healer_proposal",
        details: repair,
      });
    }

    const finalReuseAttempt = outcome.retryAttempt ?? outcome.reuseAttempt;
    if (
      existingTestFile
      && finalReuseAttempt?.failureType === "application"
      && failed?.status === "failed"
    ) {
      outcome.replay = finalReuseAttempt;
      outcome.error = `Application failure was confirmed by both the existing Playwright test and MCP exploration: ${failed.detail}`;
      outcome.failureType = "application";
      await move("failed", "existing_test_application_failure_confirmed", {
        file: existingTestFile,
        stepId: failed.stepId,
      });
      await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
        status: "FAILED",
        lastExecutionAt: new Date().toISOString(),
        lastPassedStep: steps.filter(step => step.status === "passed").length,
      });
      outcome.locatorMetrics = {
        ...(await getLocatorMetrics()),
        run: resolver?.getRunMetrics() ?? { reuseCount: 0, missCount: 0, failureCount: 0, repairCount: 0 },
      };
      await writeFile(artifacts.metrics, JSON.stringify(outcome.locatorMetrics, null, 2));
      const safeOutcome = redactExecutionData(outcome, executionId);
      await writeFile(artifacts.result, JSON.stringify(safeOutcome, null, 2));
      await reportProgress({
        phase: "finished",
        stage: "failed",
        currentStep: steps.length,
        totalSteps: plan.steps.length,
        currentUrl,
        locatorsFound: steps.filter(item => item.locatorKey).length,
        confidence: testCase.confidence,
        errorReason: outcome.error,
        plannedSteps: plan.steps.map(step => step.sourceStep),
        steps: redactExecutionData(steps, executionId),
        observation: outcome.error,
      });
      return safeOutcome;
    }

    if (!failed && existingTestFile) {
      outcome.error = undefined;
      outcome.failureType = undefined;
    }

    if (!outcome.screenshot && browser) {
      const screenshot = path.join(outputDir, "exploration.png");
      try {
        await browser.callTool("browser_take_screenshot", { filename: screenshot });
        outcome.screenshot = screenshot;
      } catch (error) {
        outcome.screenshotError = error instanceof Error ? error.message : String(error);
      }
    }
    if (outcome.screenshot) artifacts.explorationScreenshot = outcome.screenshot;

    await reportProgress({
      phase: "executing",
      stage: "generating_script",
      currentStep: plan.steps.length,
      totalSteps: plan.steps.length,
      currentUrl,
      locatorsFound: steps.filter(item => item.locatorKey).length,
      confidence: testCase.confidence,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: redactExecutionData(steps, executionId),
      observation: `Exploration Complete. Locators Identified: ${steps.filter(item => item.locatorKey).length}. Generating Playwright script`,
    });
    await move("generating", "test_generation_started");
    const previousMetadata = await getScriptMetadata(story.id ?? "unassigned-story", testCase.id);
    await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
      status: existingTestFile ? "HEALING" : "GENERATING",
      ...(existingTestFile ? { scriptPath: existingTestFile } : {}),
      ...(existingTestFile ? { lastHealingAt: new Date().toISOString() } : {}),
    });
    const registry = new LocatorRegistry();
    const verifiedLocators = await Promise.all(
      steps.flatMap((step) => step.status === "passed" && step.locatorKey
        ? [registry.get(step.locatorKey).then((record) => record
            ? {
                stepId: step.stepId,
                sourceStep: step.sourceStep,
                locator: record.locator,
                evidence: record.evidence,
              }
            : undefined)]
        : []),
    );
    const verifiedLocatorRecords = verifiedLocators.filter(
      (item): item is NonNullable<typeof item> => item !== undefined,
    );
    const generationInput = {
      storyId: story.id,
      actionPlan: plan,
      testCase: {
        id: testCase.id,
        title: testCase.title,
        expectedOutcome: testCase.expectedOutcome,
        steps: testCase.steps,
      },
      testData,
      verifiedLocators: verifiedLocatorRecords,
      reusableSteps,
    };
    const failedExistingStepId = finalReuseAttempt?.failedStepId;
    let generatedTest: string;
    if (existingTestFile && failedExistingStepId && steps.some(step => step.stepId === failedExistingStepId && step.status === "passed")) {
      await reportProgress({
        phase: "executing",
        currentStep: steps.filter(step => step.status === "passed").length,
        totalSteps: testCase.steps.length,
        plannedSteps: testCase.steps,
        steps: redactExecutionData(steps, executionId),
        observation: `Healing existing Playwright script at ${failedExistingStepId}`,
      });
      try {
        generatedTest = await repairGeneratedTestStep(generationInput, existingTestFile, failedExistingStepId);
        outcome.testSource = "healed";
        await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
          scriptPath: generatedTest,
          status: "HEALED",
          lastHealingAt: new Date().toISOString(),
          version: (previousMetadata?.version ?? 0) + 1,
        });
        outcome.recovery = {
          strategy: "mcp-assisted-healing",
          initialReplayStatus: outcome.reuseAttempt?.status,
          failedStepId: failedExistingStepId,
          repairedStepOnly: true,
        };
        await recordExecutionEvent({
          executionId,
          storyId: story.id,
          testCaseId: testCase.id,
          status,
          event: "existing_test_step_repaired",
          details: { file: generatedTest, stepId: failedExistingStepId },
        });
      } catch (error) {
        if (!(error instanceof GeneratedStepRepairUnavailableError)) throw error;
        await recordExecutionEvent({
          executionId,
          storyId: story.id,
          testCaseId: testCase.id,
          status,
          event: "existing_test_step_repair_unavailable",
          details: { stepId: failedExistingStepId, error: error instanceof Error ? error.message : String(error) },
        });
        generatedTest = await generateTestFile(generationInput);
        outcome.testSource = "generated";
        await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
          scriptPath: generatedTest,
          status: "GENERATED",
          version: (previousMetadata?.version ?? 0) + 1,
        });
        outcome.recovery = {
          strategy: "regenerated-after-healing-failed",
          initialReplayStatus: outcome.reuseAttempt?.status,
          retryStatus: outcome.retryAttempt?.status,
          failedStepId: failedExistingStepId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      generatedTest = await generateTestFile(generationInput);
      outcome.testSource = "generated";
      await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
        scriptPath: generatedTest,
        status: "GENERATED",
        version: (previousMetadata?.version ?? 0) + 1,
      });
      if (existingTestFile) {
        outcome.recovery = {
          strategy: "regenerated-after-healing-failed",
          initialReplayStatus: outcome.reuseAttempt?.status,
          retryStatus: outcome.retryAttempt?.status,
          failedStepId: failedExistingStepId,
          reason: failedExistingStepId
            ? "MCP did not verify the failed step, so a targeted repair was not safe"
            : "The Playwright reporter did not identify a source step to repair",
        };
      }
    }
    outcome.generatedTest = generatedTest;
    artifacts.generatedTest = generatedTest;
    await recordExecutionEvent({
      executionId,
      storyId: story.id,
      testCaseId: testCase.id,
      status,
      event: outcome.testSource === "healed" ? "test_healed" : "test_generated",
      details: { file: generatedTest, source: outcome.testSource, repairedStepId: finalReuseAttempt?.failedStepId },
    });

    await reportProgress({
      phase: "executing",
      stage: "validating_script",
      currentStep: plan.steps.length,
      totalSteps: plan.steps.length,
      currentUrl,
      locatorsFound: verifiedLocatorRecords.length,
      confidence: testCase.confidence,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: redactExecutionData(steps, executionId),
      observation: "Script Generated. Source checks passed; running Playwright validation",
    });
    await move("replaying", "fresh_replay_started", { file: generatedTest });
    const replay = await replayGeneratedTest({
      file: generatedTest,
      executionId,
      approvedAssertionTexts: plan.steps
        .filter((step) => step.action.startsWith("assert") && step.expected)
        .map((step) => step.expected!),
      approvedOptionNames: verifiedLocatorRecords
        .filter((item) => item.locator.strategy === "role" && item.locator.role === "option" && item.locator.exact)
        .map((item) => item.locator.value),
      testData,
      attemptName: existingTestFile ? "healed" : undefined,
      onStepProgress: replayProgressCallback(testCase.steps, onProgress),
    });
    outcome.replay = replay;
    if (replay.artifacts) {
      for (const [name, file] of Object.entries(replay.artifacts)) artifacts[`replay${capitalize(name)}`] = file;
    }
    if (replay.status === "passed") {
      outcome.error = undefined;
      outcome.failureType = undefined;
    }
    const replayFailureType = replay.status === "passed" ? undefined : replay.failureType ?? "automation";
    const applicationFailure = replay.status !== "passed"
      && (outcome.failureType === "application" || replayFailureType === "application");
    const automationFailure = replay.status !== "passed"
      && (outcome.failureType === "automation" || replayFailureType === "automation");
    const finalStatus: ExecutionStatus = applicationFailure ? "failed" : automationFailure ? "blocked" : "passed";
    outcome.failureType = applicationFailure ? "application" : automationFailure ? "automation" : undefined;
    if (replay.status !== "passed") {
      outcome.error = `Fresh Playwright replay ${replay.status}: ${replay.stderr || replay.stdout}`;
    }
    await reportProgress({
      phase: "executing",
      stage: "validating_script",
      currentStep: finalStatus === "passed" ? testCase.steps.length : steps.filter(step => step.status === "passed").length,
      totalSteps: testCase.steps.length,
      currentUrl,
      locatorsFound: verifiedLocatorRecords.length,
      confidence: testCase.confidence,
      errorReason: outcome.error,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: redactExecutionData(steps, executionId),
      observation: finalStatus === "passed"
        ? "Validation Passed. Generated Playwright script completed successfully"
        : `Validation ${finalStatus}: ${outcome.error ?? "Playwright validation did not pass"}`,
    });
    await move(finalStatus, "execution_finished", {
      replayStatus: replay.status,
      failureType: outcome.failureType,
    });
    await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
      scriptPath: generatedTest,
      status: finalStatus === "passed" ? outcome.testSource === "healed" ? "HEALED" : "PASSED"
        : finalStatus === "failed" ? "FAILED" : generatedTest ? "NEEDS_HEALING" : "BLOCKED",
      lastExecutionAt: new Date().toISOString(),
      lastPassedStep: replay.status === "passed"
        ? testCase.steps.length
        : replay.failedStepId ? Math.max(0, Number(replay.failedStepId.slice(1)) - 1) : 0,
    });
    const finalSteps = replay.status === "passed"
      ? replayStepResults(testCase.steps, replay)
      : steps.some(step => step.status !== "passed")
        ? steps
        : replayStepResults(testCase.steps, replay);
    await reportProgress({
      phase: "executing",
      stage: "saving_script",
      currentStep: finalSteps.filter(step => step.status === "passed").length,
      totalSteps: testCase.steps.length,
      currentUrl,
      locatorsFound: verifiedLocatorRecords.length,
      confidence: testCase.confidence,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: redactExecutionData(finalSteps, executionId),
      observation: "Playwright validation finished. Saving script metadata",
    });
    await reportProgress({
      phase: "finished",
      stage: finalStatus === "passed" ? "completed" : finalStatus === "failed" ? "failed" : "blocked",
      currentStep: finalSteps.filter(step => step.status === "passed").length,
      totalSteps: testCase.steps.length,
      currentUrl,
      locatorsFound: verifiedLocatorRecords.length,
      confidence: testCase.confidence,
      errorReason: outcome.error,
      plannedSteps: plan.steps.map(step => step.sourceStep),
      steps: redactExecutionData(finalSteps, executionId),
      observation: `Execution ${finalStatus}${outcome.error ? `: ${outcome.error}` : ""}`,
    });
    const aggregateMetrics = await getLocatorMetrics();
    const safeMetrics = {
      ...aggregateMetrics,
      run: resolver?.getRunMetrics() ?? { reuseCount: 0, missCount: 0, failureCount: 0, repairCount: 0 },
    };
    outcome.locatorMetrics = safeMetrics;
    await writeFile(artifacts.metrics, JSON.stringify(safeMetrics, null, 2));
    const safeOutcome = redactExecutionData(outcome, executionId);
    await writeFile(artifacts.result, JSON.stringify(safeOutcome, null, 2));
    return safeOutcome;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
    if (!statusIsTerminal(status)) {
      const terminal: ExecutionStatus = status === "queued" ? "failed" : "blocked";
      outcome.failureType = "automation";
      await move(terminal, "execution_error", { error: outcome.error });
      await reportProgress({
        phase: "finished",
        stage: terminal === "failed" ? "failed" : "blocked",
        currentStep: steps.length,
        totalSteps: testCase.steps.length,
        locatorsFound: steps.filter(item => item.locatorKey).length,
        confidence: testCase.confidence,
        errorReason: outcome.error,
        plannedSteps: testCase.steps,
        steps: redactExecutionData(steps, executionId),
        observation: redactExecutionData(
          `${terminal === "failed" ? "Failed" : "Blocked"}: ${outcome.error}`,
          executionId,
        ) as string,
      });
    }
    await saveExecutionCheckpoint(redactExecutionData({
      storyId: story.id ?? "unassigned-story",
      testCaseId: testCase.id,
      executionId: checkpointExecutionId,
      lastPassedStep: steps.reduce((last, step) => {
        const index = Number(step.stepId.slice(1));
        return step.status === "passed" && Number.isInteger(index) ? Math.max(last, index) : last;
      }, 0),
      lastExecutedStep: steps.reduce((last, step) => {
        const index = Number(step.stepId.slice(1));
        return Number.isInteger(index) ? Math.max(last, index) : last;
      }, 0),
      status: outcome.status === "passed" ? "PASSED" : outcome.status === "failed" ? "FAILED" : "BLOCKED",
      startedAt,
      endedAt: new Date().toISOString(),
      lastError: outcome.error,
    }, executionId));
    await updateScriptMetadata(story.id ?? "unassigned-story", testCase.id, {
      status: outcome.status === "passed" ? "PASSED" : outcome.status === "failed" ? "FAILED"
        : outcome.generatedTest ? "NEEDS_HEALING" : "BLOCKED",
      ...(outcome.generatedTest ? { scriptPath: outcome.generatedTest } : {}),
      lastExecutionAt: new Date().toISOString(),
    });
    const safeOutcome = redactExecutionData(outcome, executionId);
    await writeFile(artifacts.result, JSON.stringify(safeOutcome, null, 2));
    return safeOutcome;
  } finally {
    try {
      await browser?.close();
    } finally {
      clearExecutionRedactions(executionId);
    }
  }
}

async function connectMcpWithRetry(
  configPath: string,
  executionId: string,
  storyId: string | undefined,
  testCaseId: string,
  onRetry?: (attempt: number, error: string) => void | Promise<void>,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await PlaywrightMcpClient.connect({ configPath });
    } catch (error) {
      lastError = error;
      await recordExecutionEvent({
        executionId,
        storyId,
        testCaseId,
        status: "exploring",
        event: "mcp_connection_retry",
        details: { attempt, limit: 3, error: error instanceof Error ? error.message : String(error) },
      });
      await onRetry?.(attempt, error instanceof Error ? error.message : String(error));
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`Playwright MCP connection failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function makePlanWithRetry(
  planner: PlannerService,
  testCase: TestCase,
  storyId: string | undefined,
  onRetry: (attempt: number, error: string) => void | Promise<void>,
) {
  const timeoutMs = configuredPlanningTimeout();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withTimeout(
        planner.makeTypedPlan(testCase, storyId),
        timeoutMs,
        `Planning timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      lastError = error;
      if (attempt < 2) await onRetry(attempt, error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Planning failed after 2 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function configuredPlanningTimeout() {
  const timeoutMs = Number(process.env.PLANNING_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("PLANNING_TIMEOUT_MS must be a positive integer");
  }
  return timeoutMs;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validatePlanForCase(plan: { testCaseId: string; steps: Array<{ sourceStep: string; action: string; expected?: string; value?: string; valueRef?: string }> }, testCase: TestCase) {
  if (plan.testCaseId !== testCase.id) {
    throw new Error(`Planner returned case '${plan.testCaseId}' for requested case '${testCase.id}'`);
  }
  validatePlanActionIntents(plan, testCase);
  let cursor = 0;
  for (const approvedStep of testCase.steps) {
    const expected = normalizeStep(approvedStep);
    const match = plan.steps.findIndex((step, index) => index >= cursor && normalizeStep(step.sourceStep) === expected);
    if (match < 0) throw new Error(`Typed action plan omitted or reordered approved step: ${approvedStep}`);
    const valueAssertion = approvedStep.match(/^Verify value:\s*(.+?)\s+equals\s+(.+)$/i);
    if (valueAssertion) {
      const assertion = plan.steps[match];
      const approvedValue = valueAssertion[2].trim().replace(/^["']|["']$/g, "");
      const plannedValue = assertion.valueRef
        ? testCase.test_data?.find(item => item.name === assertion.valueRef)?.value
        : assertion.expected ?? assertion.value;
      if (assertion.action !== "assertValue" || String(plannedValue) !== approvedValue) {
        throw new Error(`Typed action plan changed the approved value assertion: ${approvedStep}`);
      }
    }
    cursor = match + 1;
  }
  if (!plan.steps.some(step => step.action.startsWith("assert"))) {
    throw new Error("Typed action plan has no observable assertion; add an explicit verification step to the approved test case");
  }
}

function normalizeStep(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function createIsolatedMcpConfig(outputDir: string) {
  const mcpOutputDir = path.join(outputDir, "mcp");
  await mkdir(mcpOutputDir, { recursive: true });
  const destination = path.join(outputDir, "mcp-config.json");
  await writeFile(destination, JSON.stringify(createMcpBrowserConfig(mcpOutputDir), null, 2), "utf8");
  return destination;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function replayStepResults(
  sourceSteps: string[],
  replay: ReplayResult,
): StepResult[] {
  if (replay.status === "passed") {
    return sourceSteps.map((sourceStep, index) => ({
      stepId: `S${index + 1}`,
      sourceStep,
      status: "passed",
      detail: "Covered by the passing existing Playwright test",
    }));
  }

  const failedIndex = replay.failedStepId
    ? Number(replay.failedStepId.slice(1)) - 1
    : -1;
  if (failedIndex < 0 || !Number.isInteger(failedIndex)) {
    return [{
      stepId: "REPLAY",
      sourceStep: "Execute existing Playwright test",
      status: replay.status === "failed" ? "failed" : "blocked",
      detail: replay.failureMessage ?? replay.stderr,
    }];
  }
  const steps: StepResult[] = sourceSteps.slice(0, Math.min(failedIndex, sourceSteps.length)).map((sourceStep, index) => ({
    stepId: `S${index + 1}`,
    sourceStep,
    status: "passed" as const,
    detail: "Completed before the existing Playwright test failure",
  }));
  steps.push({
    stepId: replay.failedStepId!,
    sourceStep: sourceSteps[failedIndex] ?? "Approved expected-outcome assertion",
    status: replay.status === "failed" ? "failed" : "blocked",
    detail: replay.failureMessage ?? replay.stderr,
  });
  return steps;
}

function replayProgressCallback(
  sourceSteps: string[],
  onProgress?: CaseProgressCallback,
) {
  const states = new Map<number, StepResult>();
  return async (progress: { stepId: string; status: "running" | "passed" | "failed"; detail: string }) => {
    const index = Number(progress.stepId.slice(1)) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sourceSteps.length) return;
    if (progress.status !== "running") {
      states.set(index, {
        stepId: progress.stepId,
        sourceStep: sourceSteps[index],
        status: progress.status,
        detail: progress.detail,
      });
    }
    const completedSteps = [...states.values()].sort((left, right) =>
      Number(left.stepId.slice(1)) - Number(right.stepId.slice(1)),
    );
    const passedCount = completedSteps.filter(step => step.status === "passed").length;
    await onProgress?.({
      phase: "executing",
      currentStep: passedCount,
      totalSteps: sourceSteps.length,
      activeStepId: progress.status === "running" ? progress.stepId : undefined,
      plannedSteps: sourceSteps,
      steps: completedSteps,
      observation: progress.status === "running"
        ? `Running ${progress.stepId}: ${sourceSteps[index]}`
        : `${progress.stepId} ${progress.status === "passed" ? "Passed" : "Failed"}: ${sourceSteps[index]}`,
    });
  };
}

function statusIsTerminal(status: ExecutionStatus) {
  return status === "passed" || status === "failed" || status === "blocked";
}
