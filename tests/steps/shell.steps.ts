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

Then("the health schema version is visible", async ({ page }) => {
  await expect(page.getByTestId("schema-version")).toBeVisible({
    timeout: 15_000,
  });
});

When("I switch the language to Bahasa Indonesia", async ({ page }) => {
  await page.getByTestId("locale-select").selectOption("id");
});

Then("I see the home page in Bahasa Indonesia", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("KajianQ");
  await expect(page.getByText("Kesehatan API")).toBeVisible();
});

Then("the page has no serious accessibility violations", async ({ page }) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  // Serious/critical axe violations fail the suite. The mapped summary (rule +
  // target selectors) surfaces in the assertion diff for triage.
  expect(
    blocking.map(
      (v) =>
        `${v.impact}: ${v.id} — ${v.help} @ ${v.nodes
          .map((n) => n.target.join(","))
          .join(" | ")}`,
    ),
  ).toEqual([]);
});
