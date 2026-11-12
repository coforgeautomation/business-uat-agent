// Generated for AIT-6-TC-001; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-001", async ({ page }) => {
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
  await test.step("S3: Verify selected option Round Trip trip type is selected", async () => {
    await common.expectSelected(flightSearch.journeyTypeLocator("roundTrip"));

  });

  // S4
  await test.step("S4: The flight search widget loads with Round Trip selected as the default journey type.", async () => {
    await common.expectSelected(flightSearch.journeyTypeLocator("roundTrip"));

  });

});
