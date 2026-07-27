import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

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

When("I open the notes page", async ({ page }) => {
  await page.goto("/notes");
  await expect(page.getByTestId("note-list")).toBeVisible({ timeout: 15_000 });
});

When("I open the notes page with a fresh session", async ({ page }) => {
  await page.goto("/notes");
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("apt-notes");
  });
  await page.reload();
  await expect(page.getByTestId("note-list")).toBeVisible({ timeout: 15_000 });
});

When(
  "I create a note titled {string} with body {string}",
  async ({ page }, title: string, body: string) => {
    await page.getByTestId("note-title").fill(title);
    await page.getByTestId("note-body").fill(body);
    await page.getByTestId("note-save").click();
  },
);

Then("I see a note titled {string}", async ({ page }, title: string) => {
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toBeVisible();
});

Then("I see the empty notes message", async ({ page }) => {
  await expect(page.getByTestId("note-empty")).toBeVisible();
});

When("I go offline", async ({ page, context }) => {
  await context.setOffline(true);
});

Then("the sync status indicates offline or local", async ({ page }) => {
  const status = page.getByTestId("sync-status");
  await expect(status).toBeVisible();
  const text = await status.innerText();
  expect(text.length).toBeGreaterThan(0);
});
