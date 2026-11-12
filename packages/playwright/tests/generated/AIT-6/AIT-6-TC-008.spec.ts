// Generated for AIT-6-TC-008; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-008", async ({ page }) => {
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
  await test.step("S4: Enter CityWithMultipleAirports in Origin field", async () => {
    await flightSearch.fillAirport("origin", requireTestData("originCityWithMultipleAirports"));

  });

  // S5
  await test.step("S5: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("originCityWithMultipleAirports"));

  });

  // S6
  await test.step("S6: Select suggestion matching CityWithMultipleAirports from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  // S7
  await test.step("S7: Click Destination field", async () => {
    await common.click(flightSearch.destination);
  });

  // S8
  await test.step("S8: Enter DifferentAirportSameCity in Destination field", async () => {
    await flightSearch.fillAirport("destination", requireTestData("destinationDifferentAirportSameCity"));

  });

  // S9
  await test.step("S9: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("destinationDifferentAirportSameCity"));

  });

  // S10
  await test.step("S10: Verify same-city airports are excluded from Destination suggestions", async () => {
    await expect(
      page.getByRole("option").filter({ hasText: "London, United Kingdom" }),
    ).toHaveCount(0);
  });

});
