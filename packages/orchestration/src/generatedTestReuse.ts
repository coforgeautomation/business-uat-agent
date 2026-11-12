import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { generatedTestFilePath } from "../../playwright/services/testCodeGenerator.js";
import type { TestCase } from "../../domain/schemas/test-plan.schema.js";

export type ReusableGeneratedTest = { file: string };
export type GeneratedTestLookup = ReusableGeneratedTest | { reason: string };
export type ReusableStepImplementation = {
  sourceStep: string;
  body: string;
  file: string;
  testCaseId: string;
};

export async function findReusableGeneratedTest(
  storyId: string | undefined,
  testCase: Pick<TestCase, "id" | "steps">,
): Promise<GeneratedTestLookup | undefined> {
  const file = generatedTestFilePath(storyId, testCase.id);
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const validation = validateReusableGeneratedTest(source, testCase);
  return validation ? { reason: validation } : { file };
}

export async function findReusableStepImplementations(
  testCase: Pick<TestCase, "steps" | "test_data">,
  expectedNavigationUrl?: string,
  generatedRoot = path.resolve("packages/playwright/tests/generated"),
  excludedFile?: string,
): Promise<Map<string, ReusableStepImplementation>> {
  const candidates = await generatedSpecFiles(generatedRoot);
  const matches = new Map<string, ReusableStepImplementation>();
  const currentData = new Map((testCase.test_data ?? []).map(item => [item.name, String(item.value)]));
  const stepCounts = new Map<string, number>();
  for (const step of testCase.steps) {
    const key = normalizeStep(step);
    stepCounts.set(key, (stepCounts.get(key) ?? 0) + 1);
  }

  for (const file of candidates) {
    if (excludedFile && path.resolve(file) === path.resolve(excludedFile)) continue;
    const source = await readFile(file, "utf8");
    const testCaseId = source.match(/\btest\s*\(\s*["']([^"']+)["']/)?.[1];
    if (!testCaseId) continue;
    for (const implementation of extractStepImplementations(source, file, testCaseId)) {
      const key = normalizeStep(implementation.sourceStep);
      if ((stepCounts.get(key) ?? 0) > 1) continue;
      if (!testCase.steps.some(step => normalizeStep(step) === key) || matches.has(key)) continue;
      if (key === "open application" && expectedNavigationUrl
        && !implementation.body.includes(JSON.stringify(expectedNavigationUrl))) continue;
      if (!compatibleTestData(implementation.body, currentData, testCase.steps)) continue;
      matches.set(key, implementation);
    }
  }

  return matches;
}

export function extractStepImplementations(
  source: string,
  file: string,
  testCaseId = "unknown",
): ReusableStepImplementation[] {
  const lines = source.split(/\r?\n/);
  const result: ReusableStepImplementation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*await test\.step\((.+), async \(\) => \{$/);
    if (!match) continue;
    let title: string;
    try {
      title = JSON.parse(match[1]) as string;
    } catch {
      continue;
    }
    const sourceStep = title.replace(/^S\d+:\s*/, "");
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && !/^\s*\}\);$/.test(lines[end])) {
      body.push(lines[end].replace(/^\s{4}/, ""));
      end += 1;
    }
    if (!sourceStep || end === lines.length) continue;
    result.push({ sourceStep, body: body.join("\n").trim(), file, testCaseId });
    index = end;
  }
  return result;
}

export function validateReusableGeneratedTest(
  source: string,
  testCase: Pick<TestCase, "id" | "steps">,
): string | undefined {
  const escapedId = testCase.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\btest\\s*\\(\\s*["']${escapedId}["']`).test(source)) {
    return "The existing spec does not register the selected test case ID";
  }
  const lines = new Set(source.split(/\r?\n/));
  for (const [index] of testCase.steps.entries()) {
    if (!lines.has(`  // S${index + 1}`)) return `The existing spec is missing approved step S${index + 1}`;
  }
  return undefined;
}

async function generatedSpecFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not inspect generated Playwright specs in '${root}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = await Promise.all(entries.map(async entry => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return generatedSpecFiles(file);
    return entry.isFile() && entry.name.endsWith(".spec.ts") ? [file] : [];
  }));
  return files.flat();
}

function compatibleTestData(
  body: string,
  testData: Map<string, string>,
  steps: string[],
) {
  const referencedKeys = [...body.matchAll(/requireTestData\(["']([^"']+)["']\)/g)].map(match => match[1]);
  return referencedKeys.every(key => {
    const value = testData.get(key);
    return value !== undefined && steps.some(step => step.includes(value));
  });
}

function normalizeStep(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.,!?;:]+$/g, "").toLocaleLowerCase();
}
