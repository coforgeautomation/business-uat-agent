import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-8-TC-012", async ({ page }) => {
  const common = new CommonPage(page);
  const flightSearch = new FlightSearchPage(page);

  await test.step("S1: Open application", async () => {
    await page.goto("https://www.etihad.com/en-in/", { waitUntil: "domcontentloaded" });
  });

  await test.step("S2: Wait for page load", async () => {
    await flightSearch.waitUntilReady("https://www.etihad.com/en-in/");
  });

  await test.step("S3: Select Abu Dhabi as Origin", async () => {
    await common.click(flightSearch.origin);
    await flightSearch.fillAirport("origin", requireTestData("origin_search"));
    await flightSearch.waitForAirportSuggestions(requireTestData("origin_search"));
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  await test.step("S4: Select Mumbai as Destination", async () => {
    await common.click(flightSearch.destination);
    await flightSearch.fillAirport("destination", requireTestData("destination_search"));
    await flightSearch.waitForAirportSuggestions(requireTestData("destination_search"));
    await flightSearch.selectFirstAirportSuggestion("destination");
  });

  await test.step("S5: Increase Children to two", async () => {
    await flightSearch.changePassengerCount("Children", "increase");
    await flightSearch.changePassengerCount("Children", "increase");
    await expect(flightSearch.passengerCount("Children")).toHaveValue("2");
    await expect(page.getByText(/2\s+Children/i)).toBeVisible();
  });

  await test.step("S6: Decrease Children to one and verify the updated summary", async () => {
    await flightSearch.changePassengerCount("Children", "decrease");
    await expect(flightSearch.passengerCount("Children")).toHaveValue("1");
    await expect(page.getByText(/1\s+Child(?:ren)?/i)).toBeVisible();
  });
});
