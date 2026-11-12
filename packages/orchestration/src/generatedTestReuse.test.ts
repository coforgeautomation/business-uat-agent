import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractStepImplementations,
  findReusableStepImplementations,
  validateReusableGeneratedTest,
} from "./generatedTestReuse.js";

test("reuses a generated spec only when it registers the case and covers every approved source step", () => {
  const testCase = {
    id: "TC-001",
    steps: ["Open application", "Click Search"],
  };
  const source = [
    'test("TC-001", async ({ page }) => {',
    "  // S1",
    "  await page.goto(\"https://example.test/\");",
    "  // S2",
    "  await page.getByRole(\"button\", { name: \"Search\" }).click();",
    "});",
  ].join("\n");

  assert.equal(validateReusableGeneratedTest(source, testCase), undefined);
  assert.match(
    validateReusableGeneratedTest(source.replace('test("TC-001"', 'test("TC-002"'), testCase) ?? "",
    /does not register/,
  );
  assert.match(
    validateReusableGeneratedTest(source.replace("  // S2\n", ""), testCase) ?? "",
    /missing approved step S2/,
  );
});

test("extracts generated Playwright step bodies with their source titles", () => {
  const steps = extractStepImplementations([
    'test("TC-001", async ({ page }) => {',
    '  await test.step("S1: Open application", async () => {',
    '    await page.goto("https://example.test/");',
    "  });",
    "});",
  ].join("\n"), "TC-001.spec.ts", "TC-001");

  assert.deepEqual(steps, [{
    sourceStep: "Open application",
    body: 'await page.goto("https://example.test/");',
    file: "TC-001.spec.ts",
    testCaseId: "TC-001",
  }]);
});

test("matches compatible steps from another generated story and rejects a different application URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generated-step-reuse-"));
  const sourceFile = path.join(root, "AIT-8", "TC-001.spec.ts");
  try {
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, [
      'test("TC-001", async ({ page }) => {',
      '  await test.step("S1: Open application", async () => {',
      '    await page.goto("https://example.test/");',
      "  });",
      '  await test.step("S2: Enter JFK in Flying from", async () => {',
      '    await flightSearch.fillAirport("origin", requireTestData("origin"));',
      "  });",
      "});",
    ].join("\n"));

    const matches = await findReusableStepImplementations({
      steps: ["Open application", "Enter JFK in Flying from"],
      test_data: [{ name: "origin", value: "JFK" }],
    }, "https://example.test/", root);
    assert.deepEqual([...matches.keys()], ["open application", "enter jfk in flying from"]);

    const otherApplicationMatches = await findReusableStepImplementations({
      steps: ["Open application"],
      test_data: [],
    }, "https://another.test/", root);
    assert.equal(otherApplicationMatches.size, 0);

    const excludingFailedSpec = await findReusableStepImplementations({
      steps: ["Open application", "Enter JFK in Flying from"],
      test_data: [{ name: "origin", value: "JFK" }],
    }, "https://example.test/", root, sourceFile);
    assert.equal(excludingFailedSpec.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not reuse one implementation for repeated steps that may use different test data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generated-repeated-step-reuse-"));
  const sourceFile = path.join(root, "AIT-8", "TC-001.spec.ts");
  try {
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, [
      'test("TC-001", async ({ page }) => {',
      '  await test.step("S1: Wait for airport suggestions", async () => {',
      '    await flightSearch.waitForAirportSuggestions(requireTestData("origin_search"));',
      "  });",
      '  await test.step("S2: Wait for airport suggestions", async () => {',
      '    await flightSearch.waitForAirportSuggestions(requireTestData("destination_search"));',
      "  });",
      "});",
    ].join("\n"));

    const matches = await findReusableStepImplementations({
      steps: [
        "Enter Abu Dhabi in Origin field",
        "Wait for airport suggestions",
        "Enter Mumbai in Destination field",
        "Wait for airport suggestions",
      ],
      test_data: [
        { name: "origin_search", value: "Abu Dhabi" },
        { name: "destination_search", value: "Mumbai" },
      ],
    }, "https://example.test/", root);

    assert.equal(matches.has("wait for airport suggestions"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
