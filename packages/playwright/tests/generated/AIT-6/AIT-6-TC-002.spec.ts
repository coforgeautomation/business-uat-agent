// Generated for AIT-6-TC-002; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-002", async ({ page }) => {
  const common = new CommonPage(page);
  const flightSearch = new FlightSearchPage(page);

  // S1
  await test.step("S1: Open application", async () => {
    await page.goto("https://www.etihad.com/en-in/", { waitUntil: "domcontentloaded" });
  });

  // S2
  await test.step("S2: Wait for page load", async () => {
    await flightSearch.waitUntilReady("https://www.etihad.com/en-in/");
  });

  // S3
  await test.step("S3: Click Origin field", async () => {
    await common.click(flightSearch.origin);
  });

  // S4
  await test.step("S4: Enter AUH in Origin field", async () => {
    await flightSearch.fillAirport("origin", requireTestData("originSearchValue"));
  });

  // S5
  await test.step("S5: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("originSearchValue"));
  });

  // S6
  await test.step("S6: Select suggestion matching AUH from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  // S7
  await test.step("S7: Verify Origin field value matches the selected airport", async () => {
    await common.expectContainsText(flightSearch.origin, requireTestData("originSearchValue"));

  });

});
