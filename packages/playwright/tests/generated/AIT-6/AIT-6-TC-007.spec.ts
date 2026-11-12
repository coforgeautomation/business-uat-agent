// Generated for AIT-6-TC-007; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-007", async ({ page }) => {
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
    await flightSearch.selectAirportSuggestion("origin", requireTestData("originSearchValue"));
  });

  // S7
  await test.step("S7: Click Destination field", async () => {
    await common.click(flightSearch.destination);
  });

  // S8
  await test.step("S8: Enter AUH in Destination field", async () => {
    await common.fill(common.locator({"strategy":"role","value":"Flying to","role":"combobox","exact":true,"scope":"tabpanel"}), requireTestData("originSearchValue"));

  });

  // S9
  await test.step("S9: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("originSearchValue"));

  });

  // S10
  await test.step("S10: Select suggestion matching AUH from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("destination");
  });

  // S11
  await test.step("S11: Verify message Origin and Destination must be different is displayed", async () => {
    await common.expectVisible(page.getByText("Origin and Destination must be different", { exact: true }));

  });

});
