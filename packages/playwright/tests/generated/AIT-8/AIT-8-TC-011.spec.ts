import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-8-TC-011", async ({ page }) => {
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

  await test.step("S5: Set Adults to nine occupied seats", async () => {
    for (let count = 1; count < 9; count += 1) {
      await flightSearch.changePassengerCount("Adults", "increase");
    }
    await expect(flightSearch.passengerCount("Adults")).toHaveValue("9");
  });

  await test.step("S6: Verify another occupied-seat passenger cannot be added", async () => {
    await expect(flightSearch.passengerControl("Children", "increase")).toBeDisabled();
    await expect(flightSearch.passengerCount("Children")).toHaveValue("0");
    await expect(flightSearch.passengerCount("Adults")).toHaveValue("9");
  });
});
