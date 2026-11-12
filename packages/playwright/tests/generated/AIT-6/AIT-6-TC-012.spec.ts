// Generated for AIT-6-TC-012; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-012", async ({ page }) => {
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
  await test.step("S3: Click Multi City trip type", async () => {
    await flightSearch.selectJourneyType("multiCity");

  });

  // S4
  await test.step("S4: Verify page navigation Multi City itinerary inputs are displayed", async () => {
    await common.expectVisible(flightSearch.journeyTypeLocator("multiCity"));

  });

  // S5
  await test.step("S5: Verify selected option Multi City trip type is selected", async () => {
    await common.expectSelected(flightSearch.journeyTypeLocator("multiCity"));

  });

});
