import { expect, type Locator, type Page } from "@playwright/test";
import type { LocatorDescriptor } from "../schemas/locator.schema.js";

export class CommonPage {
  constructor(protected readonly page: Page) {}

  locator(descriptor: LocatorDescriptor): Locator {
    switch (descriptor.strategy) {
      case "role":
        if (!descriptor.role) throw new Error("Role locator descriptor is missing its role");
        return this.page.getByRole(descriptor.role, {
          name: descriptor.value,
          exact: descriptor.exact,
        });
      case "label":
        return this.page.getByLabel(descriptor.value, { exact: descriptor.exact });
      case "testId":
        return this.page.getByTestId(descriptor.value);
      case "placeholder":
        return this.page.getByPlaceholder(descriptor.value, { exact: descriptor.exact });
      case "text":
        return this.page.getByText(descriptor.value, { exact: descriptor.exact });
      case "css":
        return this.page.locator(descriptor.value);
    }
  }

  async click(locator: Locator): Promise<void> {
    await locator.click();
  }

  async openApplication(){
    await this.page.goto("https://www.etihad.com/en-in/", { waitUntil: "domcontentloaded" });
  }

  async clickIfPresent(locator: Locator): Promise<void> {
    const count = await locator.count();
    if (count > 1) throw new Error(`Expected at most one optional control, found ${count}`);
    if (count === 1 && await locator.isVisible()) await locator.click();
  }

  async fill(locator: Locator, value: string): Promise<void> {
    await locator.fill(value);
  }

  async press(locator: Locator, key: string): Promise<void> {
    await locator.press(key);
  }

  async expectVisible(locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
  }

  async expectHidden(locator: Locator): Promise<void> {
    await expect(locator).toBeHidden();
  }

  async expectEnabled(locator: Locator): Promise<void> {
    await expect(locator).toBeEnabled();
  }

  async expectDisabled(locator: Locator): Promise<void> {
    await expect(locator).toBeDisabled();
  }

  async expectValue(locator: Locator, value: string): Promise<void> {
    await expect(locator).toHaveValue(value);
  }

  async expectContainsText(locator: Locator, expected: string): Promise<void> {
  const tagName = await locator.evaluate(
    (el) => el.tagName.toLowerCase()
  );

  if (tagName === "input" || tagName === "textarea") {
    await expect(locator).toHaveValue(
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  } else {
    await expect(locator).toContainText(expected);
  }
}

  async expectSelected(locator: Locator): Promise<void> {
    const selected = await locator.getAttribute("aria-selected");
    const pressed = await locator.getAttribute("aria-pressed");
    if (selected !== null) return expect(locator).toHaveAttribute("aria-selected", "true");
    if (pressed !== null) return expect(locator).toHaveAttribute("aria-pressed", "true");
    await expect(locator).toBeChecked();
  }

  async expectUnselected(locator: Locator): Promise<void> {
    const selected = await locator.getAttribute("aria-selected");
    const pressed = await locator.getAttribute("aria-pressed");
    if (selected !== null) return expect(locator).toHaveAttribute("aria-selected", "false");
    if (pressed !== null) return expect(locator).toHaveAttribute("aria-pressed", "false");
    await expect(locator).not.toBeChecked();
  }
}
