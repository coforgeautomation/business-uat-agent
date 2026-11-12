import { ExecutionPlanSchema, type PlannedStep } from "../schemas/actionPlan.schema.js";
import type { PlaywrightMcpClient } from "../mcp/playwrightMcpClient.js";
import { findPassengerControlState, LocatorResolutionError, LocatorResolver } from "./locatorResolver.js";
import { proposeRepair, type RepairProposal } from "./healer.js";

export type StepResult = {
  stepId: string; sourceStep: string; status: "passed" | "failed" | "blocked";
  detail: string; locatorKey?: string; reusedLocator?: boolean; repairs?: RepairProposal[];
  recoveryReason?: string;
};

export class ApplicationAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationAssertionError";
  }
}

export async function executePlan(input: {
  plan: unknown; browser: PlaywrightMcpClient; testData?: Record<string, unknown>;
  pageKey?: string; resolver?: LocatorResolver;
  onStepStart?: (step: PlannedStep, completedSteps: number, totalSteps: number) => void | Promise<void>;
  onStep?: (step: StepResult, completedSteps: StepResult[], totalSteps: number) => void | Promise<void>;
  onLocatorDiscoveryRetry?: (step: PlannedStep, attempt: number, limit: number, detail: string) => void | Promise<void>;
  onMcpPlannerRecovery?: (
    step: PlannedStep,
    snapshot: string,
    failure: string,
    attempt: number,
    limit: number,
  ) => Promise<{ step: PlannedStep; reason: string } | { blockedReason: string }>;
  onPlanStepApplied?: (originalStep: PlannedStep, effectiveStep: PlannedStep) => void | Promise<void>;
}): Promise<StepResult[]> {
  const plan = ExecutionPlanSchema.parse(input.plan);
  const resolver = input.resolver ?? new LocatorResolver();
  const results: StepResult[] = [];
  let pageKey = input.pageKey ?? "unknown-page";

  for (const [stepIndex, step] of plan.steps.entries()) {
    await input.onStepStart?.(step, results.length, plan.steps.length);
    try {
      let effectiveStep = step;
      let recoveryReason: string | undefined;
      let result: Awaited<ReturnType<typeof executeStep>>;
      const recoveryLimit = input.onMcpPlannerRecovery ? configuredMcpPlannerRecoveryAttempts() : 0;
      let recoveryAttempt = 0;
      while (true) {
        try {
          result = await executeStep(
            effectiveStep,
            input.browser,
            resolver,
            input.testData ?? {},
            pageKey,
            plan.steps[stepIndex + 1],
            input.onLocatorDiscoveryRetry,
          );
          break;
        } catch (error) {
          if (!(error instanceof LocatorResolutionError)
              || !input.onMcpPlannerRecovery
              || recoveryAttempt >= recoveryLimit) {
            throw error;
          }
          recoveryAttempt += 1;
          const snapshot = await readSnapshot(input.browser);
          const decision = await input.onMcpPlannerRecovery(
            effectiveStep,
            snapshot,
            error.message,
            recoveryAttempt,
            recoveryLimit,
          );
          if ("blockedReason" in decision) {
            throw new LocatorResolutionError(
              `MCP planner blocked recovery for ${step.id}: ${decision.blockedReason}`,
            );
          }
          validateAlternateStep(effectiveStep, decision.step);
          effectiveStep = decision.step;
          recoveryReason = decision.reason;
        }
      }
      const stepResult: StepResult = {
        stepId: step.id,
        sourceStep: step.sourceStep,
        status: "passed",
        detail: recoveryReason ? `${result.detail}; MCP planner recovery: ${recoveryReason}` : result.detail,
        locatorKey: result.locatorKey, reusedLocator: result.reused, repairs: result.repairs,
        ...(recoveryReason ? { recoveryReason } : {}),
      };
      results.push(stepResult);
      if (effectiveStep !== step) await input.onPlanStepApplied?.(step, effectiveStep);
      await input.onStep?.(stepResult, [...results], plan.steps.length);
      if (step.action === "navigate") pageKey = pageKeyFromUrl(step.value ?? "");
    } catch (error) {
      const stepResult: StepResult = {
        stepId: step.id,
        sourceStep: step.sourceStep,
        status: error instanceof ApplicationAssertionError ? "failed" : "blocked",
        detail: error instanceof Error ? error.message : String(error),
      };
      results.push(stepResult);
      await input.onStep?.(stepResult, [...results], plan.steps.length);
      if (!(error instanceof ApplicationAssertionError)) break;
    }
  }
  return results;
}

function validateAlternateStep(original: PlannedStep, alternate: PlannedStep): void {
  if (alternate.id !== original.id
      || alternate.sourceStep !== original.sourceStep
      || alternate.action !== original.action
      || alternate.value !== original.value
      || alternate.valueRef !== original.valueRef
      || alternate.expected !== original.expected
      || alternate.timeoutMs !== original.timeoutMs
      || alternate.locatorKey !== original.locatorKey
      || !alternate.target
      || alternate.target === original.target) {
    throw new Error(`MCP planner changed approved intent instead of proposing a new target for ${original.id}`);
  }
}

function configuredMcpPlannerRecoveryAttempts(): number {
  const raw = Number(process.env.MCP_PLANNER_RECOVERY_ATTEMPTS ?? "2");
  if (!Number.isInteger(raw) || raw < 0 || raw > 3) {
    throw new Error("MCP_PLANNER_RECOVERY_ATTEMPTS must be an integer from 0 to 3");
  }
  return raw;
}

async function executeStep(
  step: PlannedStep,
  browser: PlaywrightMcpClient,
  resolver: LocatorResolver,
  data: Record<string, unknown>,
  pageKey: string,
  nextStep?: PlannedStep,
  onLocatorDiscoveryRetry?: (step: PlannedStep, attempt: number, limit: number, detail: string) => void | Promise<void>,
) {
  if (step.action === "navigate") {
    await callWithRetry(browser, "browser_navigate", { url: step.value });
    return { detail: `Navigated to ${step.value}` };
  }
  if (step.action === "noOp") return { detail: "No interaction performed as explicitly requested by the approved step" };
  const snapshot = await readSnapshot(browser);
  if (step.action === "waitForLoad") {
    const url = snapshot.match(/Page URL:\s*(\S+)/)?.[1];
    if (!url) throw new Error("Page did not report a URL after navigation");
    return { detail: `Verified page is ready at ${url}` };
  }
  if (step.action === "waitForText") {
    const text = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
    if (/airport suggestions?/i.test(step.sourceStep)) {
      const deadline = Date.now() + (step.timeoutMs ?? 10_000);
      let currentSnapshot = snapshot;
      while (!hasVisibleOption(currentSnapshot, text) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        currentSnapshot = await readSnapshot(browser);
      }
      if (!hasVisibleOption(currentSnapshot, text)) {
        throw new ApplicationAssertionError(`Expected a visible airport suggestion containing '${text}' within ${step.timeoutMs ?? 10_000}ms`);
      }
      return { detail: `Verified visible airport suggestion containing '${text}'` };
    }
    await callWithRetry(browser, "browser_wait_for", { text, time: step.timeoutMs ? step.timeoutMs / 1000 : undefined });
    return { detail: `Waited for text: ${text}` };
  }
  if (step.action === "assertUrl") {
    const expected = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
    const url = snapshot.match(/Page URL:\s*(\S+)/)?.[1] ?? "";
    if (!url.includes(expected)) throw new ApplicationAssertionError(`Expected URL to contain '${expected}', got '${url}'`);
    return { detail: `Verified URL contains '${expected}'` };
  }
  if (step.action === "assertUrlNot") {
    const forbidden = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
    const url = snapshot.match(/Page URL:\s*(\S+)/)?.[1] ?? "";
    if (url.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase())) {
      throw new ApplicationAssertionError(`Expected URL not to contain '${forbidden}', got '${url}'`);
    }
    return { detail: `Verified URL does not contain '${forbidden}'` };
  }
  if (step.action === "assertVisible" && step.expected) {
    const expected = resolveTestValue(step.valueRef ?? step.expected, data);
    if (!snapshot.includes(expected)) {
      throw new ApplicationAssertionError(`Expected visible text not found: ${expected}`);
    }
    return { detail: `Verified visible text '${expected}'` };
  }
  if (step.action === "assertVisible") {
    const target = step.target ?? "";
    if (!snapshotMentionsTarget(snapshot, target)) throw new ApplicationAssertionError(`Expected visible: ${target}`);
    return { detail: `Verified visible '${target}'` };
  }
  if (step.action === "assertHidden") {
    const target = step.target ?? step.locatorKey ?? "";
    const visible = isGuestsCabinTarget(target)
      ? guestsCabinPanelVisible(snapshot)
      : snapshotMentionsTarget(snapshot, target);
    if (visible) throw new ApplicationAssertionError(`Expected '${target}' to be hidden, but it appears in the accessibility snapshot`);
    return { detail: `Verified '${target}' is absent from the accessibility snapshot` };
  }
  const target = step.target ?? step.locatorKey!;
  if (step.action === "click" && isAirportSuggestionTarget(target)) {
    const expected = resolveTestValue(step.valueRef ?? step.expected ?? target.replace(/^Airport suggestions:\s*/i, ""), data);
    const deadline = Date.now() + (step.timeoutMs ?? 10_000);
    let suggestionSnapshot = snapshot;
    let option = firstVisibleOption(suggestionSnapshot, expected);
    while (!option && Date.now() < deadline) {
      await delay(250);
      suggestionSnapshot = await readSnapshot(browser);
      option = firstVisibleOption(suggestionSnapshot, expected);
    }
    if (!option) throw new ApplicationAssertionError("No visible airport suggestion option is available to select");
    await callActionWithStaleRefRecovery({ browser, resolver, target: option.name, pageKey, data, ref: option.ref });
    await readSnapshot(browser);
    return {
      detail: `Selected first visible airport suggestion: ${option.name}`,
      locatorKey: undefined,
      reused: undefined,
    };
  }
  if (step.action === "click" && nextStep?.action === "assertHidden"
      && normalizeTarget(nextStep.target ?? "") === normalizeTarget(target)
      && !snapshotMentionsTarget(snapshot, target)) {
    return { detail: `No '${target}' control is exposed; the next approved step verifies that it remains hidden` };
  }
  if (step.action === "assertValue") {
    const passengerValue = readPassengerCount(snapshot, target);
    if (passengerValue !== undefined) {
      const expected = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
      if (passengerValue !== expected) {
        throw new ApplicationAssertionError(`Expected value '${expected}' for '${target}', received '${passengerValue}'`);
      }
      return { detail: `Verified ${target} value is '${expected}' from its passenger row` };
    }
  }
  if (step.action === "assertEnabled" || step.action === "assertDisabled") {
    const passengerControl = findPassengerControlState(snapshot, target);
    if (passengerControl) {
      const expectedDisabled = step.action === "assertDisabled";
      if (passengerControl.disabled !== expectedDisabled) {
        throw new ApplicationAssertionError(`Expected ${expectedDisabled ? "disabled" : "enabled"}: ${target}`);
      }
      return { detail: `Verified ${target} is ${expectedDisabled ? "disabled" : "enabled"} from its passenger row` };
    }
  }
  const locatorTarget = canonicalLocatorTarget(target, step, data);
  const resolvedResult = await resolveWithRepair({
    step, target: locatorTarget, action: step.action, pageKey, snapshot, browser, resolver, data,
    onLocatorDiscoveryRetry,
  });
  const resolved = resolvedResult.locator;
  if (step.action === "assertText") {
    const expected = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
    if (!snapshotSubtreeContainsText(snapshot, resolved.mcpRef, expected)) {
      throw new ApplicationAssertionError(`Expected '${target}' to contain text '${expected}'`);
    }
    return { detail: `Verified '${target}' contains text '${expected}'`, locatorKey: resolved.key, reused: resolved.reused, repairs: resolvedResult.repairs };
  }
  if (step.action === "click") await callActionWithStaleRefRecovery({
    browser, resolver, target: locatorTarget, pageKey, data, ref: resolved.mcpRef,
  });
  else if (step.action === "fill") {
    const value = step.valueRef ? data[step.valueRef] : step.value;
    if (value === undefined || value === null) throw new Error(`No test data value for '${step.valueRef}'`);
    await fillWithRecovery({ browser, resolver, target: locatorTarget, pageKey, data, ref: resolved.mcpRef, value: String(value) });
  } else if (step.action === "press") await browser.callTool("browser_press_key", { key: step.value ?? "Enter" });
  else {
    const line = snapshot.split("\n").find(item => item.includes(`[ref=${resolved.mcpRef}]`)) ?? "";
    const hasDisabled = /\bdisabled\b/i.test(line);
    if (step.action === "assertDisabled" && !hasDisabled) throw new ApplicationAssertionError(`Expected disabled: ${target}`);
    if (step.action === "assertEnabled" && hasDisabled) throw new ApplicationAssertionError(`Expected enabled: ${target}`);
    if (step.action === "assertSelected" || step.action === "assertUnselected") {
      const observable = /\[(?:checked|selected|pressed)(?:\s|=|\])|aria-(?:checked|selected|pressed)="(?:true|false)"|aria-current="(?:page|step|location|date|time|true)"|checked="(?:true|false)"/i.test(line);
      if (!observable) throw new ApplicationAssertionError(`Selection state for '${target}' is not exposed by the live page`);
      const selected = /\[(?:checked|selected|pressed)\]|(?:aria-checked|aria-selected|aria-pressed)="?true"?|aria-current="(?:page|step|location|date|time|true)"|checked="true"/i.test(line);
      if (step.action === "assertSelected" && !selected) throw new ApplicationAssertionError(`Expected '${target}' to be selected`);
      if (step.action === "assertUnselected" && selected) throw new ApplicationAssertionError(`Expected '${target}' not to be selected`);
    }
    if (step.action === "assertValue") {
      const expected = resolveTestValue(step.valueRef ?? step.expected ?? step.value ?? "", data);
      const actual = snapshotControlValue(line);
      if (actual !== expected) {
        throw new ApplicationAssertionError(`Expected value '${expected}' for '${target}', received '${actual ?? "not exposed in the accessibility snapshot"}'`);
      }
    }
  }
  const after = ["click", "fill", "press"].includes(step.action) ? await readSnapshot(browser) : undefined;
  return {
    detail: `Executed ${step.action} on '${target}'${after ? " and captured post-action snapshot" : ""}${resolvedResult.repairs.length ? ` after ${resolvedResult.repairs.length} locator repair` : ""}`,
    locatorKey: resolved.key,
    reused: resolved.reused,
    repairs: resolvedResult.repairs.length ? resolvedResult.repairs : undefined,
  };
}

async function resolveWithRepair(input: {
  step: PlannedStep; target: string; pageKey: string; snapshot: string;
  browser: PlaywrightMcpClient; resolver: LocatorResolver; data: Record<string, unknown>;
  action: PlannedStep["action"];
  onLocatorDiscoveryRetry?: (step: PlannedStep, attempt: number, limit: number, detail: string) => void | Promise<void>;
}) {
  const sensitiveValues = Object.values(input.data).map(String);
  try {
    const snapshot = await waitForTargetSnapshot(input.browser, input.target);
    return { locator: await input.resolver.resolve({ ...input, snapshot, sensitiveValues }), repairs: [] as RepairProposal[] };
  } catch (error) {
    if (!(error instanceof LocatorResolutionError)) throw error;
    const maxAttempts = Number(process.env.MAX_HEAL_ATTEMPTS ?? 2);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 0) throw new Error("MAX_HEAL_ATTEMPTS must be a non-negative integer");
    const repairs: RepairProposal[] = [];
    let failure: unknown = error;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await input.onLocatorDiscoveryRetry?.(
        input.step,
        attempt + 1,
        maxAttempts,
        `Locator discovery failed for '${input.target}': ${error.message}. Asking Planner for an alternate path and re-discovering with MCP`,
      );
      const currentSnapshot = await waitForTargetSnapshot(input.browser, input.target);
      const proposal = await proposeRepair({
        failure: error instanceof Error ? error.message : String(error),
        evidence: {
          stepId: input.step.id,
          sourceStep: redactSnapshot(input.step.sourceStep, sensitiveValues),
          target: redactSnapshot(input.target, sensitiveValues),
          snapshot: redactSnapshot(currentSnapshot, sensitiveValues),
        },
        attempt,
        maxAttempts,
      });
      repairs.push(proposal);
      if (proposal.status !== "repair_proposed" || !proposal.locatorHint) {
        throw new LocatorResolutionError(`Locator repair blocked for ${input.step.id}: ${proposal.reason}`);
      }
      try {
        const locator = await input.resolver.resolve({
          target: input.target,
          pageKey: input.pageKey,
          snapshot: currentSnapshot,
          browser: input.browser,
          sensitiveValues,
          repair: proposal.locatorHint,
          action: input.action,
        });
        return { locator, repairs };
      } catch (repairError) {
        failure = repairError;
        if (!(repairError instanceof LocatorResolutionError)) throw repairError;
      }
    }
    throw new LocatorResolutionError(`Locator repair limit reached for ${input.step.id}: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}

async function readSnapshot(browser: PlaywrightMcpClient) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await browser.callTool("browser_snapshot");
      return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }
  throw new Error(`Could not capture Playwright MCP snapshot after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function callWithRetry(browser: PlaywrightMcpClient, tool: string, args: Record<string, unknown>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await browser.callTool(tool, args);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }
  throw new Error(`Playwright MCP tool '${tool}' failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForTargetSnapshot(browser: PlaywrightMcpClient, target: string) {
  const deadline = Date.now() + 5_000;
  let snapshot = await readSnapshot(browser);
  while (!snapshotMentionsTarget(snapshot, target) && Date.now() < deadline) {
    await delay(300);
    snapshot = await readSnapshot(browser);
  }
  return snapshot;
}

async function callActionWithStaleRefRecovery(input: {
  browser: PlaywrightMcpClient;
  resolver: LocatorResolver;
  target: string;
  pageKey: string;
  data: Record<string, unknown>;
  ref: string;
}) {
  try {
    await input.browser.callTool("browser_click", { target: input.ref });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ref.{0,30}(?:stale|invalid|not found|no longer)|(?:stale|invalid).{0,30}ref|snapshot.{0,30}(?:changed|stale)/i.test(message)) throw error;
    const snapshot = await waitForTargetSnapshot(input.browser, input.target);
    const resolved = await input.resolver.resolve({
      target: input.target,
      pageKey: input.pageKey,
      snapshot,
      browser: input.browser,
      sensitiveValues: Object.values(input.data).map(String),
      action: "click",
    });
    await input.browser.callTool("browser_click", { target: resolved.mcpRef });
  }
}

async function fillWithRecovery(input: {
  browser: PlaywrightMcpClient;
  resolver: LocatorResolver;
  target: string;
  pageKey: string;
  data: Record<string, unknown>;
  ref: string;
  value: string;
}) {
  let currentRef = input.ref;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt === 0) {
        await callActionWithStaleRefRecovery({
          browser: input.browser,
          resolver: input.resolver,
          target: input.target,
          pageKey: input.pageKey,
          data: input.data,
          ref: input.ref,
        });
      } else {
        const snapshot = await waitForTargetSnapshot(input.browser, input.target);
        const locator = await input.resolver.resolve({
          target: input.target,
          pageKey: input.pageKey,
          snapshot,
          browser: input.browser,
          sensitiveValues: Object.values(input.data).map(String),
          action: "fill",
        });
        currentRef = locator.mcpRef;
        await input.browser.callTool("browser_click", { target: currentRef });
      }
      await input.browser.callTool("browser_press_key", { key: "Control+A" });
      await input.browser.callTool("browser_press_key", { key: "Backspace" });
      await input.browser.callTool("browser_type", { target: currentRef, text: input.value });
      return;
    } catch (error) {
      if (attempt > 0) throw error;
      const current = await readSnapshot(input.browser);
      const line = findTargetLine(current, input.target);
      if (line && snapshotControlValue(line) === input.value) return;
      await delay(300);
    }
  }
}

function findTargetLine(snapshot: string, target: string): string | undefined {
  const aliases = semanticTargetAliases(target).map(normalizeTarget);
  const lines = snapshot.split("\n").filter(line => {
    if (!/\[ref=[^\]]+\]/.test(line)) return false;
    const name = snapshotLineName(line);
    return name !== undefined && aliases.includes(normalizeTarget(name));
  });
  if (lines.length === 1) return lines[0];
  if (/^(adults?|children|infants?|infantwithseat)$/i.test(normalizeTarget(target))) {
    const withValue = lines.filter(line => snapshotControlValue(line) !== undefined);
    if (withValue.length === 1) return withValue[0];
  }
  return undefined;
}

function snapshotMentionsTarget(snapshot: string, target: string) {
  const aliases = semanticTargetAliases(target).map(normalizeTarget);
  return snapshot.split("\n").some(line => {
    const name = snapshotLineName(line);
    return name !== undefined && aliases.includes(normalizeTarget(name));
  }) || aliases.some(alias => alias && normalizeTarget(snapshot).includes(alias));
}

function snapshotSubtreeContainsText(snapshot: string, ref: string, expected: string): boolean {
  const lines = snapshot.split("\n");
  const targetIndex = lines.findIndex(line => line.includes(`[ref=${ref}]`));
  if (targetIndex < 0) return false;
  const targetIndent = lines[targetIndex].match(/^\s*/)?.[0].length ?? 0;
  const subtree = [lines[targetIndex]];
  for (let index = targetIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= targetIndent) break;
    subtree.push(line);
  }
  return subtree.join("\n").toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function isGuestsCabinTarget(target: string) {
  return ["guestsandcabin", "passengersandcabin"].includes(normalizeTarget(target));
}

function guestsCabinPanelVisible(snapshot: string) {
  return /\bradio\s+"(?:Economy|Business|First)"/i.test(snapshot)
    && /\b(?:Adults|Children|Infants)\b/i.test(snapshot);
}

function snapshotLineName(line: string): string | undefined {
  const roleMatch = line.match(/\b(?:button|link|tab|option|radio|checkbox|combobox|textbox|spinbutton|searchbox|heading|generic|text|listbox|group)\s+"([^"]+)"/i);
  if (roleMatch) return roleMatch[1];
  const textMatch = line.trim().match(/^(?:[-*]\s*)?text:\s*(.+)$/i);
  return textMatch?.[1].trim();
}

function semanticTargetAliases(target: string): string[] {
  const normalized = normalizeTarget(target);
  const aliases = new Set([normalized]);
  if (["origin", "flyingfrom"].includes(normalized)) ["origin", "flyingfrom", "departure"].forEach(value => aliases.add(value));
  if (["destination", "flyingto"].includes(normalized)) ["destination", "flyingto", "arrival"].forEach(value => aliases.add(value));
  if (["guestsandcabin", "passengersandcabin"].includes(normalized)) {
    ["guestsandcabin", "passengersandcabin", "guestscabin", "passengerscabin"].forEach(value => aliases.add(value));
  }
  const passengerControl = normalized.match(/^(increase|decrease)(adults?|children|infants?|infantwithseat)$/);
  if (passengerControl) {
    const [direction, group] = passengerControl.slice(1);
    const singular = group.endsWith("s") ? group.slice(0, -1) : group;
    const verbs = direction === "increase" ? ["increase", "add", "plus"] : ["decrease", "remove", "minus"];
    for (const verb of verbs) {
      aliases.add(`${verb}${group}`);
      aliases.add(`${group}${verb}`);
      aliases.add(`${verb}${singular}`);
      aliases.add(`${singular}${verb}`);
    }
  }
  if (normalized === "search") aliases.add("searchflights");
  return [...aliases];
}

function normalizeTarget(value: string) {
  return value.toLocaleLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function redactSnapshot(snapshot: string, values: string[]) {
  return values.filter(value => value.length > 0).sort((a, b) => b.length - a.length)
    .reduce((safe, value) => safe.split(value).join("[REDACTED]"), snapshot);
}

function snapshotControlValue(line: string): string | undefined {
  const withoutRef = line.replace(/\s+\[ref=[^\]]+\]/g, "").trim();
  const colon = withoutRef.indexOf(":");
  return colon < 0 ? undefined : withoutRef.slice(colon + 1).trim();
}

function hasVisibleOption(snapshot: string, expected: string) {
  const normalizedExpected = expected.trim().toLocaleLowerCase();
  if (!normalizedExpected) return false;
  return snapshot.split("\n").some(line =>
    /\boption\s+"[^"]*"/i.test(line)
    && line.toLocaleLowerCase().includes(normalizedExpected),
  );
}

function firstVisibleOption(snapshot: string, expected?: string): { name: string; ref: string } | undefined {
  for (const line of snapshot.split("\n")) {
    const match = line.match(/\boption\s+"([^"]+)"\s+\[ref=([^\]]+)\]/i);
    if (match && (!expected || normalizeTarget(match[1]).includes(normalizeTarget(expected)))) {
      return { name: match[1], ref: match[2] };
    }
  }
  return undefined;
}

function isAirportSuggestionTarget(target: string) {
  return /airport suggestions?/i.test(target);
}

function readPassengerCount(snapshot: string, target: string): string | undefined {
  const normalizedTarget = normalizeTarget(target);
  const groupAliases: Record<string, string> = {
    adult: "adults",
    adults: "adults",
    child: "children",
    children: "children",
    infant: "infants",
    infants: "infants",
    infantwithseat: "infantswithseat",
    infantswithseat: "infantswithseat",
  };
  const group = groupAliases[normalizedTarget];
  if (!group) return undefined;
  const lines = snapshot.split("\n");
  const groupLabels = new Set(["adults", "children", "infants", "infantswithseat"]);
  const labels = lines.flatMap((line, index) => {
    const label = line.match(/:\s*([^:]+)\s*$/)?.[1];
    const normalized = label ? normalizeTarget(label) : "";
    return groupLabels.has(normalized) ? [{ index, group: normalized }] : [];
  });
  const matches = labels.filter(label => label.group === group);
  if (matches.length !== 1) return undefined;
  const labelPosition = labels.indexOf(matches[0]);
  const nextLabel = labels[labelPosition + 1]?.index ?? lines.length;
  const values = lines.slice(matches[0].index + 1, nextLabel).flatMap(line => {
    const match = line.match(/\btextbox:\s*"([^"]+)"/i);
    return match ? [match[1]] : [];
  });
  return values.length === 1 ? values[0] : undefined;
}

function resolveTestValue(value: string, data: Record<string, unknown>) {
  const resolved = Object.prototype.hasOwnProperty.call(data, value) ? data[value] : value;
  return String(resolved);
}

function canonicalLocatorTarget(target: string, step: PlannedStep, data: Record<string, unknown>) {
  if (step.action !== "click") return target;
  const suggestion = target.match(/airport suggestions?(?:\s+option)?\s*:\s*["']?(.+?)["']?$/i);
  if (!suggestion) return target;
  const airport = resolveTestValue(step.valueRef ?? suggestion[1].trim(), data);
  return `Airport suggestions: ${airport}`;
}

function pageKeyFromUrl(url: string) {
  try { return new URL(url).pathname.split("/").filter(Boolean).join("-") || "home"; }
  catch { return "unknown-page"; }
}
