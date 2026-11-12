// Generated for AIT-6-TC-015; replay status is recorded separately.
import { expect, test } from "@playwright/test";
import { CommonPage } from "../../../pages/CommonPage.js";
import { FlightSearchPage } from "../../../pages/FlightSearchPage.js";

test("AIT-6-TC-015", async ({ page }) => {
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
  await test.step("S3: Click Destination field", async () => {
    await common.click(flightSearch.destination);
  });

  // S4
  await test.step("S4: Wait for airport suggestions", async () => {
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
  });

  // S5
  await test.step("S5: Select the first popular destination using the keyboard", async () => {
    await flightSearch.destination.press("ArrowDown");
    await flightSearch.destination.press("Tab");
  });

  // S6
  await test.step("S6: Verify a Destination was selected", async () => {
    await expect(flightSearch.destination).not.toHaveValue("");
  });
});
