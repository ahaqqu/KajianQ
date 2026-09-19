import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

const { Before, When, Then } = createBdd();

/**
 * The About and Collection pages, and the header nav that reaches them. The
 * burger disclosure is asserted at a mobile viewport (the `< sm` breakpoint
 * collapses the inline nav), so the browser's real CSS decides which layout the
 * page uses — the jsdom component tests pin the disclosure contract.
 */

// Every scenario gets its own `page` (fresh browser context), so this reset is
// belt-and-braces (thermo-review C2): it guarantees a desktop viewport even if
// the config ever moves to shared contexts or reordered scenarios.
Before(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
});

When("I open the about page", async ({ page }) => {
  await page.goto("/about");
});

When("I open the collection page", async ({ page }) => {
  await page.goto("/collection");
});

When("I open the collection page on a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/collection");
});

Then("I see the primary navigation", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.getByRole("link", { name: "Obrolan" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Koleksi" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tentang" })).toBeVisible();
});

When("I follow the {string} nav link", async ({ page }, name: string) => {
  await page
    .getByRole("navigation", { name: "Navigasi utama" })
    .getByRole("link", { name })
    .click();
});

Then("I see the collection page", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koleksi");
  await expect(page).toHaveURL(/\/collection$/);
});

Then("I see the about page", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tentang KajianQ");
  await expect(page).toHaveURL(/\/about$/);
});

Then("the navigation is collapsed into a burger button", async ({ page }) => {
  const toggle = page.getByTestId("nav-menu-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

When("I open the burger menu", async ({ page }) => {
  await page.getByTestId("nav-menu-toggle").click();
});

Then("I see the nav links in the menu", async ({ page }) => {
  const menu = page.getByTestId("nav-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("nav-menu-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("link", { name: "Koleksi" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Tentang" })).toBeVisible();
});

When("I follow the {string} link in the menu", async ({ page }, name: string) => {
  await page.getByTestId("nav-menu").getByRole("link", { name }).click();
});

Then("the burger menu is closed", async ({ page }) => {
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
  await expect(page.getByTestId("nav-menu-toggle")).toHaveAttribute("aria-expanded", "false");
});

Then(
  "I see an entry marked {string} for the Uthmani Quran text",
  async ({ page }, mark: string) => {
    const entry = page
      .getByTestId("collection-section-available")
      .getByTestId("collection-entry")
      .first();
    await expect(entry).toHaveAttribute("data-status", "available");
    await expect(entry).toContainText(mark);
    await expect(entry).toContainText("Utsmani");
  },
);

Then("I see a planned Kitab entry", async ({ page }) => {
  const planned = page.getByTestId("collection-section-planned").getByTestId("collection-entry");
  await expect
    .poll(async () =>
      planned.evaluateAll((nodes) => nodes.every((n) => n.dataset["status"] === "planned")),
    )
    .toBe(true);
  await expect(page.getByTestId("collection-section-planned")).toContainText("Al-Umm");
});

Then("the planned entries carry their registered reference", async ({ page }) => {
  const planned = page.getByTestId("collection-section-planned");
  await expect(planned).toContainText("direncanakan · #21");
  await expect(planned).toContainText("direncanakan · #33");
});

When("I choose the {string} collection tab", async ({ page }, name: string) => {
  await page.getByTestId("collection-filter").filter({ hasText: name }).click();
});

Then("only planned entries remain", async ({ page }) => {
  const entries = page.getByTestId("collection-entry");
  const statuses = await entries.evaluateAll((nodes) => nodes.map((n) => n.dataset["status"]));
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((status) => status === "planned")).toBe(true);
});

Then("the {string} tab is the active filter", async ({ page }, name: string) => {
  const tab = page.getByTestId("collection-filter").filter({ hasText: name });
  await expect(tab).toHaveAttribute("aria-pressed", "true");
});

Then("the full register is shown again", async ({ page }) => {
  const count = await page.getByTestId("collection-entry").count();
  expect(count).toBeGreaterThan(10);
});

Then("I see the collection page in English", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The collection");
  await expect(page.getByTestId("collection-section-available")).toContainText("Available now");
});

Then("I see the about page in English", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About KajianQ");
  await expect(page.getByTestId("about-principles")).toContainText("Name the source");
});

// --- "Ask about this source" affordance (#175) ---------------------------
// The first available entry is the Uthmani Quran text; its Indonesian question
// (the page's default locale) is pinned here explicitly, so the scenario
// asserts the data module's real copy reaching the composer — not a value the
// test read back from the same link it is checking.

const FIRST_ASK_ID = "Apa yang Al-Qur'an katakan tentang kesabaran?";
const FIRST_ASK_EN = "What does the Quran say about patience?";

When("I follow the first available source's ask link", async ({ page }) => {
  await page
    .getByTestId("collection-section-available")
    .getByTestId("collection-ask")
    .first()
    .click();
});

Then("the chat opens with that source's question in the composer", async ({ page }) => {
  await expect(page.getByTestId("composer")).toHaveValue(FIRST_ASK_ID);
  await expect(page).toHaveURL(/\/$/);
});

Then("the chat URL carries no question param", async ({ page }) => {
  // The param was consumed on read, so a refresh cannot re-seed it.
  await expect(page).toHaveURL((url) => url.search === "");
});

Then("no answer was sent", async ({ page }) => {
  // Pre-fill is a draft only: no turn was appended and the empty state stands.
  await expect(page.getByTestId("message-user")).toHaveCount(0);
  await expect(page.getByTestId("chat-empty")).toBeVisible();
});

Then("the first available source's ask link is in English", async ({ page }) => {
  const link = page
    .getByTestId("collection-section-available")
    .getByTestId("collection-ask")
    .first();
  await expect(link).toHaveText("Ask about this source");
  // The question follows the locale too, not only the label.
  const q = new URL((await link.getAttribute("href"))!, "http://127.0.0.1:8787").searchParams.get(
    "q",
  );
  expect(q).toBe(FIRST_ASK_EN);
});

Then("the chat composer is empty", async ({ page }) => {
  await expect(page.getByTestId("composer")).toHaveValue("");
});
