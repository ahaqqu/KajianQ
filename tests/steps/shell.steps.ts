import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const { When, Then } = createBdd();

When("I open the home page", async ({ page }) => {
  await page.goto("/");
});

Then("I see the home title", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

When("I open the health page", async ({ page }) => {
  await page.goto("/health");
});

Then("I see the chat composer", async ({ page }) => {
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
});

Then("the health schema version is visible", async ({ page }) => {
  await expect(page.getByTestId("schema-version")).toBeVisible({
    timeout: 15_000,
  });
});

When("I switch the language to English", async ({ page }) => {
  await page.getByTestId("locale-select").selectOption("en");
});

Then("I see the health page in English", async ({ page }) => {
  await expect(page.getByText("API health")).toBeVisible();
});

Then("the page has no serious accessibility violations", async ({ page }) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  // Serious/critical axe violations fail the suite. The mapped summary (rule +
  // target selectors) surfaces in the assertion diff for triage.
  expect(
    blocking.map(
      (v) =>
        `${v.impact}: ${v.id} — ${v.help} @ ${v.nodes.map((n) => n.target.join(",")).join(" | ")}`,
    ),
  ).toEqual([]);
});

Then("I see the greeting heading", async ({ page }) => {
  await expect(page.getByTestId("chat-greeting")).toContainText(/Assalamu|Peace be/);
});

Then("I see three suggestion chips", async ({ page }) => {
  await expect(page.getByTestId("suggestion-chip")).toHaveCount(3);
});

When("I toggle the dark theme", async ({ page }) => {
  await page.getByTestId("theme-toggle").click();
});

Then("the page carries the dark theme", async ({ page }) => {
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).not.toHaveClass(/light/);
});

Then("reloading keeps the dark theme", async ({ page }) => {
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
