import { expect, type Locator, type Page } from "@playwright/test";
import { CommonPage } from "./CommonPage.js";

export type AirportField = "origin" | "destination";
export type JourneyType = "oneWay" | "roundTrip" | "multiCity";
export type PassengerGroup = "Adults" | "Children" | "Infants" | "Infants with Seat" | "Young Adults";
export type PassengerDirection = "increase" | "decrease";
export type CabinType='Economy'| 'Business' | 'First';

export class FlightSearchPage extends CommonPage {
  readonly searchPanel: Locator;
  readonly origin: Locator;
  readonly destination: Locator;
  readonly oneWay: Locator;
  readonly roundTrip: Locator;
  readonly multiCity: Locator;
  readonly searchButton: Locator;
  readonly travelDates: Locator;

  constructor(page: Page) {
    super(page);
    this.searchPanel = page.getByRole("tabpanel").filter({
      has: page.getByRole("button", { name: "Search", exact: true }),
    });
    this.origin = this.searchPanel.getByRole("combobox", {
      name: "Flying from",
      exact: true,
    });
    this.destination = this.searchPanel.getByRole("combobox", {
      name: "Flying to",
      exact: true,
    });
    this.oneWay = page.getByRole("tab", { name: "One way", exact: true });
    this.roundTrip = page.getByRole("tab", { name: "Round trip", exact: true });
    this.multiCity = page.getByRole("tab", { name: "Multi-city", exact: true });
    this.searchButton = this.searchPanel.getByRole("button", { name: "Search", exact: true });
    this.travelDates = this.searchPanel.getByRole("tab", { name: /Travel dates/ });
    
  }

  async waitUntilReady(url: string): Promise<void> {
    await expect(this.page).toHaveURL(url);
    await expect(this.searchPanel, "Expected exactly one flight-search panel.").toHaveCount(1);
    await expect(this.origin, "Expected one Origin field in the flight-search panel.").toHaveCount(1);
    await expect(this.destination, "Expected one Destination field in the flight-search panel.").toHaveCount(1);
  }

  async fillAirport(field: AirportField, value: string, leg = 1): Promise<void> {
    const locator = this.airportFieldForLeg(field, leg);
    await locator.press("Control+A");
    await locator.press("Backspace");
    await locator.pressSequentially(value);
  }

  async waitForAirportSuggestions(expectedText: string): Promise<void> {
    await expect(this.page.getByRole("listbox"), "Expected airport suggestions to be visible.").toBeVisible();
    await expect(
      this.page.getByRole("option").filter({ hasText: expectedText }),
      `Expected a visible airport suggestion containing '${expectedText}'.`,
    ).not.toHaveCount(0);
  }

  async selectFirstAirportSuggestion(field: AirportField, leg = 1): Promise<void> {
    const locator = this.airportFieldForLeg(field, leg);
    await locator.press("ArrowDown");
    await locator.press("Enter");
  }

  async selectAirportSuggestion(field: AirportField, expectedText: string, leg = 1): Promise<void> {
    await this.waitForAirportSuggestions(expectedText);
    const suggestion = this.page.getByRole("option").filter({ hasText: expectedText });
    await expect(
      suggestion,
      `Expected one airport suggestion containing '${expectedText}'.`,
    ).toHaveCount(1);
    await suggestion.click();
    await expect(this.airportFieldForLeg(field, leg)).not.toHaveValue("");
  }

  async selectJourneyType(type: JourneyType): Promise<void> {
    await this.journeyTypeLocator(type).click();
    await expect(this.journeyTypeLocator(type)).toHaveAttribute("aria-selected", "true");
  }

  journeyTypeLocator(type: JourneyType): Locator {
    if (type === "oneWay") return this.oneWay;
    if (type === "multiCity") return this.multiCity;
    return this.roundTrip;
  }

  async openTravelDates(): Promise<void> {
    const calendar = this.page.locator(".mbsc-calendar:visible, .fsp-calendar:visible").first();
    if (!await calendar.isVisible()) await this.travelDates.click();
    await expect(calendar, "Expected the travel-date calendar to be visible.").toBeVisible();
  }

  async selectTravelDate(value: string): Promise<void> {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())
        || date.toISOString().slice(0, 10) !== value) {
      throw new Error(`Invalid travel date '${value}'; expected YYYY-MM-DD`);
    }

    await this.openTravelDates();
    const mobiscroll = this.page.locator(".mbsc-calendar:visible").first();
    if (!await mobiscroll.isVisible()) {
      const calendar = this.page.locator(".fsp-calendar:visible").first();
      const renderedDays = calendar.locator(
        ".mbsc-calendar-day, [role='gridcell'], button",
      );
      await expect(
        renderedDays,
        `Etihad's date picker is visible but has not rendered selectable dates for ${value}.`,
      ).not.toHaveCount(0);
      throw new Error(`Unsupported rendered date-picker markup for ${value}`);
    }

    const monthButtons = mobiscroll.locator(".mbsc-calendar-header .mbsc-calendar-button");
    const monthLabels = await Promise.all(
      Array.from({ length: await monthButtons.count() }, (_, index) =>
        monthButtons.nth(index).innerText().then(label => label.replace(/\s+/g, " ").trim()),
      ),
    );
    const monthLabel = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date)
      + ` ${date.getUTCFullYear()}`;
    const monthIndex = monthLabels.indexOf(monthLabel);
    if (monthIndex < 0) {
      throw new Error(`Travel date ${value} is outside the visible calendar months: ${monthLabels.join(", ")}`);
    }

    const activeMonths = mobiscroll.locator(".mbsc-calendar-table-active");
    await expect(activeMonths, "Expected one active calendar table for each visible month.").toHaveCount(monthLabels.length);
    const month = activeMonths.nth(monthIndex);
    const day = month.getByText(String(date.getUTCDate()), { exact: true });
    const cell = day.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' mbsc-calendar-cell ')]");
    await expect(cell, `Expected one calendar cell for ${value}.`).toHaveCount(1);
    await expect(cell).not.toHaveClass(/mbsc-disabled|mbsc-calendar-day-outer/);
    await cell.click();
  }

  async expectGuestsCabinPanelHidden(): Promise<void> {
    await expect(this.page.getByRole("radio", { name: /^(Economy|Business|First)$/ })).toHaveCount(0);
  }

  async openGuestsCabin(): Promise<void> {
    const economy = this.cabinOption("Economy");
    if (await economy.isVisible()) return;
    await expect(this.guestsCabinTile, "Expected the Guests and Cabin control to be visible.").toBeVisible();
    await this.guestsCabinTile.click();
    await expect(economy, "Expected cabin options after opening Guests and Cabin.").toBeVisible();
  }

  async selectCabin(cabin: CabinType): Promise<void> {
    await this.openGuestsCabin();
    const option = this.cabinOption(cabin);
    await this.page.getByRole("tab", { name: cabin, exact: true }).click();
    await expect(option).toBeChecked();
  }

  async changePassengerCount(group: PassengerGroup, direction: PassengerDirection): Promise<void> {
    await this.openGuestsCabin();
    await this.passengerControl(group, direction).click();
  }

  async submitSearch(): Promise<void> {
    await expect(this.searchButton, "Expected the flight-search button to be enabled.").toBeEnabled();
    await this.searchButton.click();
  }

  get guestsCabinTile(): Locator {
    return this.page.getByText("Guests and Cabin", { exact: true });
  }

  cabinOption(cabin: CabinType): Locator {
    return this.page.getByRole("radio", { name: cabin, exact: true });
  }

  passengerCount(group: PassengerGroup): Locator {
    return this.passengerRow(group).getByRole("textbox");
  }

  passengerControl(group: PassengerGroup, direction: PassengerDirection): Locator {
    return this.passengerRow(group).getByRole("tab", {
      name: direction === "increase" ? "+" : "-",
      exact: true,
    });
  }

  airportFieldForLeg(field: AirportField, leg = 1): Locator {
    if (!Number.isInteger(leg) || leg < 1) {
      throw new Error(`Flight leg must be a positive integer; received '${leg}'`);
    }
    return this.searchPanel.getByRole("combobox", {
      name: field === "origin" ? "Flying from" : "Flying to",
      exact: true,
    }).nth(leg - 1);
  }

  private passengerRow(group: PassengerGroup): Locator {
    return this.page.getByText(group, { exact: true }).locator("xpath=ancestor::*[.//input][1]");
  }
}
