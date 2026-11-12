import { createHash } from "node:crypto";
import { AIProvider } from "../../ai/providers/AIProvider.js";
import { LocatorDescriptorSchema, type LocatorDescriptor } from "../schemas/locator.schema.js";
import { LocatorRegistry } from "../registry/locatorRegistry.js";
import type { PlaywrightMcpClient } from "../mcp/playwrightMcpClient.js";
import locatorPrompt from "../prompts/locator.prompt.js";

export type ResolvedLocator = { key: string; descriptor: LocatorDescriptor; mcpRef: string; reused: boolean; evidence: string };
export type LocatorRunMetrics = { reuseCount: number; missCount: number; failureCount: number; repairCount: number };

export class LocatorResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorResolutionError";
  }
}

export class LocatorResolver {
  private readonly runMetrics: LocatorRunMetrics = { reuseCount: 0, missCount: 0, failureCount: 0, repairCount: 0 };

  constructor(private readonly registry = new LocatorRegistry(), private readonly app = "etihad") {}

  getRunMetrics(): LocatorRunMetrics {
    return { ...this.runMetrics };
  }

  async resolve(input: {
    target: string; pageKey: string; snapshot: string; browser: PlaywrightMcpClient;
    sensitiveValues?: string[]; repair?: LocatorDescriptor;
    action?: "navigate" | "click" | "fill" | "press" | "waitForLoad" | "waitForText"
      | "assertVisible" | "assertHidden" | "assertEnabled" | "assertDisabled"
      | "assertValue" | "assertText" | "assertUrl" | "assertUrlNot" | "assertSelected" | "assertUnselected" | "noOp";
  }): Promise<ResolvedLocator> {
    const sensitiveValues = input.sensitiveValues ?? [];
    const target = redactSnapshot(input.target, sensitiveValues);
    const safeRegistryTarget = target === input.target
      ? input.target
      : `sensitive-${createHash("sha256").update(input.target).digest("hex")}`;
    const registryTarget = input.action ? `${safeRegistryTarget}::${input.action}` : safeRegistryTarget;
    const key = LocatorRegistry.key(this.app, input.pageKey, registryTarget);
    if (input.repair) {
      const locator = LocatorDescriptorSchema.parse(input.repair);
      const ref = matchSnapshotRef(input.snapshot, locator);
      if (!ref) throw new LocatorResolutionError(`Proposed repair for '${input.target}' did not uniquely match the current page`);
      await this.registry.markRepaired(key, locator, "Repaired semantic locator uniquely matched the current accessibility snapshot");
      this.runMetrics.repairCount += 1;
      return {
        key, descriptor: locator, mcpRef: ref, reused: false,
        evidence: "Repaired semantic locator uniquely matched the current accessibility snapshot",
      };
    }

    const cached = await this.registry.get(key);
    if (cached) {
      const ref = matchSnapshotRef(input.snapshot, cached.locator);
      if (ref) {
        await this.registry.recordReuse(key);
        this.runMetrics.reuseCount += 1;
        return { key, descriptor: cached.locator, mcpRef: ref, reused: true, evidence: "Cached locator matched current page snapshot" };
      }
      await this.registry.recordFailure(key);
      this.runMetrics.failureCount += 1;
    }

    await this.registry.recordMiss(this.app, input.pageKey, target);
    this.runMetrics.missCount += 1;
    const semanticMatch = findPassengerControlSnapshotMatch(input.snapshot, input.target)
      ?? findSemanticSnapshotMatch(input.snapshot, input.target, input.action);
    if (semanticMatch) {
      await this.registry.upsert({
        app: this.app,
        page: input.pageKey,
        target: registryTarget,
        locator: semanticMatch.locator,
        evidence: "Deterministic accessible name uniquely matched the fresh page snapshot",
      });
      return {
        key,
        descriptor: semanticMatch.locator,
        mcpRef: semanticMatch.ref,
        reused: false,
        evidence: "Deterministic accessible name uniquely matched the fresh page snapshot",
      };
    }
    const safeSnapshot = redactSnapshot(input.snapshot, input.sensitiveValues ?? []);
    let discovered: LocatorDescriptor;
    try {
      discovered = await this.askModel(target, safeSnapshot);
    } catch (error) {
      throw new LocatorResolutionError(`Could not discover a unique locator for '${input.target}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const ref = matchSnapshotRef(input.snapshot, discovered);
    if (!ref) throw new LocatorResolutionError(`Locator candidate for '${target}' could not be uniquely matched to the live snapshot`);
    await this.registry.upsert({
      app: this.app,
      page: input.pageKey,
      target: registryTarget,
      locator: discovered,
      evidence: "Semantic locator uniquely matched the current accessibility snapshot",
    });
    return { key, descriptor: discovered, mcpRef: ref, reused: false, evidence: "Discovered and matched against current page snapshot" };
  }

  private async askModel(target: string, snapshot: string): Promise<LocatorDescriptor> {
    const client = new AIProvider();
    const response = await client.chat([
        { role: "system", content: locatorPrompt },
        { role: "user", content: JSON.stringify({ target, snapshot }) },
      ]);
    const raw = JSON.parse(response);
    if (raw.status === "blocked" || (typeof raw.reason === "string" && !raw.locator)) {
      throw new Error(`Locator resolution blocked for '${target}': ${raw.reason ?? "ambiguous target"}`);
    }
    return LocatorDescriptorSchema.parse(raw.locator ?? raw);
  }
}

function findSemanticSnapshotMatch(snapshot: string, target: string, action?: string) {
  const aliases = semanticAliases(target).map(normalizeSemanticName);
  const candidates = snapshot.split("\n").flatMap(line => {
    const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
    if (!ref) return [];
    const roleMatch = line.match(/\b([a-z][a-z-]*)\s+"([^"]+)"/i);
    const textValue = roleMatch?.[2] ?? line.match(/:\s*([^:]+)\s*$/)?.[1]?.trim();
    if (!textValue || !aliases.includes(normalizeSemanticName(textValue))) return [];
    const roleDescriptor = roleMatch && LocatorDescriptorSchema.safeParse({
      strategy: "role",
      role: roleMatch[1].toLowerCase(),
      value: textValue,
      exact: true,
    });
    const textDescriptor = LocatorDescriptorSchema.safeParse({
      strategy: "text",
      value: textValue,
      exact: true,
    });
    const locator = roleDescriptor?.success ? roleDescriptor.data : textDescriptor.success ? textDescriptor.data : undefined;
    return locator ? [{ ref, locator }] : [];
  });
  const preferredRoles = action === "click"
    ? ["button", "tab", "option", "radio", "checkbox", "link", "textbox"]
    : ["radio", "button", "checkbox", "option", "textbox", "link", "tab"];
  for (const role of preferredRoles) {
    const preferred = candidates.filter(candidate => candidate.locator.strategy === "role" && candidate.locator.role === role);
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return undefined;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findPassengerControlSnapshotMatch(snapshot: string, target: string) {
  const control = findPassengerControlState(snapshot, target);
  if (!control?.ref) return undefined;
  return {
    ref: control.ref,
    locator: LocatorDescriptorSchema.parse({
      strategy: "role",
      role: "tab",
      value: control.value,
      exact: true,
      scope: control.group,
    }),
  };
}

export function findPassengerControlState(snapshot: string, target: string) {
  const parsed = target.match(/^(increase|decrease)\s+(adults?|children|infants?|infant with seat)$/i);
  if (!parsed) return undefined;
  const group = passengerGroupName(parsed[2]);
  const value = parsed[1].toLowerCase() === "increase" ? "+" : "-";
  return findPassengerRowControl(snapshot, group, value);
}

function findPassengerRowControl(snapshot: string, group: string, control: string) {
  const lines = snapshot.split("\n");
  const groupName = normalizeSemanticName(group);
  const labels = lines.flatMap((line, index) => {
    const label = line.match(/:\s*([^:]+)\s*$/)?.[1];
    return label && passengerGroupNames().has(normalizeSemanticName(label))
      ? [{ index, group: normalizeSemanticName(label) }]
      : [];
  });
  const matches: Array<{ line: string; ref?: string }> = [];
  for (const [labelIndex, label] of labels.entries()) {
    if (label.group !== groupName) continue;
    const nextLabelIndex = labels[labelIndex + 1]?.index ?? lines.length;
    for (const line of lines.slice(label.index + 1, nextLabelIndex)) {
      if (!new RegExp(`\\btab\\s+"${escapeRegExp(control)}"(?:\\s|$)`).test(line)) continue;
      matches.push({ line, ref: line.match(/\[ref=([^\]]+)\]/)?.[1] });
    }
  }
  if (matches.length !== 1) return undefined;
  return {
    group,
    value: control,
    line: matches[0].line,
    ref: matches[0].ref,
    disabled: /\[disabled\]/i.test(matches[0].line),
  };
}

function passengerGroupNames() {
  return new Set(["Adults", "Children", "Infants", "Infants with Seat"].map(normalizeSemanticName));
}

function passengerGroupName(value: string) {
  const normalized = normalizeSemanticName(value);
  if (normalized.startsWith("adult")) return "Adults";
  if (normalized === "children") return "Children";
  if (normalized.startsWith("infant") && normalized.includes("seat")) return "Infants with Seat";
  return "Infants";
}

function semanticAliases(target: string): string[] {
  const normalized = normalizeSemanticName(target);
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
    const words = direction === "increase" ? ["increase", "add", "plus"] : ["decrease", "remove", "minus"];
    for (const word of words) {
      aliases.add(`${word}${group}`);
      aliases.add(`${group}${word}`);
      aliases.add(`${word}${singular}`);
      aliases.add(`${singular}${word}`);
    }
  }
  return [...aliases];
}

function normalizeSemanticName(value: string) {
  return value.toLocaleLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

function redactSnapshot(snapshot: string, values: string[]) {
  return values.filter(value => value.length > 0).sort((a, b) => b.length - a.length)
    .reduce((safe, value) => safe.split(value).join("[REDACTED]"), snapshot);
}

/** Map a durable semantic locator to a fresh, session-local MCP ref. */
export function matchSnapshotRef(snapshot: string, locator: LocatorDescriptor): string | undefined {
  if (
    locator.strategy === "role"
    && locator.role === "tab"
    && locator.scope
    && ["+", "-"].includes(locator.value)
  ) {
    return findPassengerRowControl(snapshot, locator.scope, locator.value)?.ref;
  }
  const lines = snapshot.split("\n");
  const ancestors: Array<{ indent: number; line: string }> = [];
  const matches: string[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.length - line.trimStart().length;
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= indent) ancestors.pop();
    const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
    if (ref) {
      const normalized = line.toLowerCase();
      const value = locator.value.toLowerCase();
      let match = false;
      if (locator.strategy === "role") match = normalized.includes(locator.role!.toLowerCase()) && normalized.includes(value);
      else match = locator.exact ? normalized.includes(`\"${value}\"`) || normalized.includes(`'${value}'`) : normalized.includes(value);
      const scopeMatch = !locator.scope || ancestors.some(parent => parent.line.toLowerCase().includes(locator.scope!.toLowerCase()));
      if (match && scopeMatch) matches.push(ref);
    }

    ancestors.push({ indent, line });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
