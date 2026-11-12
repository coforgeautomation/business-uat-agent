import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-8-TC-010", async ({ page }) => {
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

  await test.step("S5: Select future travel dates", async () => {
    const departureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const returnDate = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    await flightSearch.selectTravelDate(departureDate.toISOString().slice(0, 10));
    await flightSearch.selectTravelDate(returnDate.toISOString().slice(0, 10));
  });

  await test.step("S6: Set occupied seats to nine", async () => {
    for (let count = 1; count < 7; count += 1) {
      await flightSearch.changePassengerCount("Adults", "increase");
    }
    await flightSearch.changePassengerCount("Children", "increase");
    await flightSearch.changePassengerCount("Infants with Seat", "increase");
    await expect(flightSearch.passengerCount("Adults")).toHaveValue("7");
    await expect(flightSearch.passengerCount("Children")).toHaveValue("1");
    await expect(flightSearch.passengerCount("Infants with Seat")).toHaveValue("1");
  });

  await test.step("S7: Search with exactly nine occupied seats", async () => {
    const searchFormUrl = page.url();
    await flightSearch.submitSearch();
    await expect(page).not.toHaveURL(searchFormUrl);
  });
});
