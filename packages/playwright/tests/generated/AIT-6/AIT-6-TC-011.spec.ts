// Generated for AIT-6-TC-011; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-011", async ({ page }) => {
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
  await test.step("S3: Click One Way trip type", async () => {
    await flightSearch.selectJourneyType("oneWay");

  });

  // S4
  await test.step("S4: Verify selected option One Way trip type is selected", async () => {
    await common.expectSelected(flightSearch.journeyTypeLocator("oneWay"));

  });

  // S5
  await test.step("S5: Verify selected option Round Trip trip type is not selected", async () => {
    await common.expectUnselected(flightSearch.journeyTypeLocator("roundTrip"));

  });

});
