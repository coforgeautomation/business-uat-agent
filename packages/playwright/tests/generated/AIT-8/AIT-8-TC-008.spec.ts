// Generated for AIT-8-TC-008; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-8-TC-008", async ({ page }) => {
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
  await test.step("S4: Enter Abu Dhabi in Origin field", async () => {
    await flightSearch.fillAirport("origin", requireTestData("origin_search"));
  });

  // S5
  await test.step("S5: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("origin_search"));

  });

  // S6
  await test.step("S6: Select Abu Dhabi from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  // S7
  await test.step("S7: Click Destination field", async () => {
    await common.click(flightSearch.destination);
  });

  // S8
  await test.step("S8: Enter Mumbai in Destination field", async () => {
    await flightSearch.fillAirport("destination", requireTestData("destination_search"));
  });

  // S9
  await test.step("S9: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("destination_search"));

  });

  // S10
  await test.step("S10: Select Mumbai from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("destination");
  });

  // S11
  await test.step("S11: Click Increase adults", async () => {
    await flightSearch.changePassengerCount("Adults", "increase");

  });

  // S12
  await test.step("S12: Click Increase adults", async () => {
    await flightSearch.changePassengerCount("Adults", "increase");

  });

  // S13
  await test.step("S13: Click Increase adults", async () => {
    await flightSearch.changePassengerCount("Adults", "increase");

  });

  // S14
  await test.step("S14: Verify value Adult passenger count equals 4", async () => {
    await common.expectValue(flightSearch.passengerCount("Adults"), "4");

  });

  // S15
  await test.step("S15: Click Increase children", async () => {
    await flightSearch.changePassengerCount("Children", "increase");

  });

  // S16
  await test.step("S16: Click Increase children", async () => {
    await flightSearch.changePassengerCount("Children", "increase");

  });

  // S17
  await test.step("S17: Click Increase children", async () => {
    await flightSearch.changePassengerCount("Children", "increase");

  });

  // S18
  await test.step("S18: Click Increase children", async () => {
    await flightSearch.changePassengerCount("Children", "increase");

  });

  // S19
  await test.step("S19: Click Increase children", async () => {
    await flightSearch.changePassengerCount("Children", "increase");

  });

  // S20
  await test.step("S20: Verify value Child passenger count equals 5", async () => {
    await common.expectValue(flightSearch.passengerCount("Children"), "5");

  });

  // S21
  await test.step("S21: The booking widget allows a valid passenger mix where occupied seats equal 9 (e.g., 4 Adults + 5 Children) without blocking the selection.", async () => {
    await common.expectDisabled(flightSearch.passengerControl("Adults", "increase"));

  });

});
