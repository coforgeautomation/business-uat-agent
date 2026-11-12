// Generated for AIT-6-TC-013; replay status is recorded separately.
import { test } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";

test("AIT-6-TC-013", async ({ page }) => {
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
  await test.step("S3: Click Guests and Cabin field", async () => {
    await common.click(flightSearch.guestsCabinTile);
  });

  // S4
  await test.step("S4: Verify cabin options remain inaccessible", async () => {
    await flightSearch.expectGuestsCabinPanelHidden();
  });
});
