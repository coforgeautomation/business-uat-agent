// Generated for AIT-6-TC-010; replay status is recorded separately.
import { test, expect } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";
import { requireTestData } from "../../../test-data/runtimeTestData.js";

test("AIT-6-TC-010", async ({ page }) => {
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
    await flightSearch.fillAirport("origin", requireTestData("origin1"));

  });

  // S5
  await test.step("S5: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("origin1"));

  });

  // S6
  await test.step("S6: Select suggestion matching AUH from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  // S7
  await test.step("S7: Click Destination field", async () => {
    await common.click(flightSearch.destination);
  });

  // S8
  await test.step("S8: Enter BOM in Destination field", async () => {
    await flightSearch.fillAirport("destination", requireTestData("destination1"));

  });

  // S9
  await test.step("S9: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("destination1"));

  });

  // S10
  await test.step("S10: Select suggestion matching BOM from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("destination");
  });

  // S11
  await test.step("S11: Click Origin field", async () => {
    await common.click(flightSearch.origin);

  });

  // S12
  await test.step("S12: Enter DEL in Origin field", async () => {
    await flightSearch.fillAirport("origin", requireTestData("origin2"));

  });

  // S13
  await test.step("S13: Wait for airport suggestions", async () => {
    await flightSearch.waitForAirportSuggestions(requireTestData("origin2"));

  });

  // S14
  await test.step("S14: Select suggestion matching DEL from airport suggestions", async () => {
    await flightSearch.selectFirstAirportSuggestion("origin");
  });

  // S15
  await test.step("S15: Verify Destination is cleared after changing Origin", async () => {
    await common.expectValue(flightSearch.destination, "");

  });

});
