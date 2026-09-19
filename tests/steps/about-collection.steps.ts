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

// --- The privacy notice (#179, GDPR-C) -----------------------------------
// The notice renders the ADR-0043 register and the retention values, with the
// netcup destination honestly marked planned (#181 has not happened) and the
// erasure path named as the endpoint that exists. The steps assert the copy
// and the status attributes a reader actually sees.

When("I see the privacy notice rendered from the register", async ({ page }) => {
  const notice = page.getByTestId("about-privacy");
  await expect(notice).toContainText("Siapa yang memproses data Anda");
  await expect(notice.getByTestId("about-privacy-controller")).toContainText("Angga (@ahaqqu)");
  // Every register row is its own card (netcup, Cloudflare, Neon, and the LLM
  // vendors), and the rule that governs them is stated.
  const processors = notice.getByTestId("about-privacy-processor");
  expect(await processors.count()).toBeGreaterThanOrEqual(8);
  await expect(notice).toContainText("netcup GmbH");
  await expect(notice).toContainText("Neon, Inc.");
  await expect(notice).toContainText("data pribadi tidak pernah lewat tingkat gratis");
  await expect(notice).toContainText("Bukan untuk data pribadi");
});

Then("I see the netcup destination marked as planned, not live", async ({ page }) => {
  const netcup = page.getByTestId("about-privacy-processor").filter({ hasText: "netcup GmbH" });
  await expect(netcup).toHaveAttribute("data-status", "planned");
  await expect(netcup.getByTestId("about-privacy-processor-status")).toHaveText("Direncanakan");
  // The vendors serving today say so, so the notice is never false.
  const cloudflare = page
    .getByTestId("about-privacy-processor")
    .filter({ hasText: "Cloudflare, Inc." });
  await expect(cloudflare).toHaveAttribute("data-status", "transition");
});

Then(
  "I see the retention row for reverse-proxy access logs marked {string}",
  async ({ page }, mark: string) => {
    const row = page
      .getByTestId("about-privacy-retention-row")
      .filter({ hasText: "Log akses reverse proxy" });
    await expect(row).toHaveAttribute("data-status", "planned");
    await expect(row).toContainText(mark);
    await expect(row).toContainText("14 hari");
  },
);

Then("the erasure card names the endpoint that erases the data", async ({ page }) => {
  const erasure = page.getByTestId("about-privacy-erasure");
  await expect(erasure).toContainText("DELETE /v1/auth/me");
  // The cascade names all four subtrees the endpoint removes.
  await expect(erasure).toContainText(
    "sesi, sesi obrolan dan pesannya, trace setiap jawaban, dan masukan",
  );
  // The gap is stated, not papered over: there is no in-app erase button yet.
  await expect(erasure).toContainText("belum punya tombol");
});

Then("I see the privacy notice in English", async ({ page }) => {
  const notice = page.getByTestId("about-privacy");
  await expect(notice).toContainText("Who processes your data");
  await expect(notice).toContainText("Not for personal data");
  await expect(notice.getByTestId("about-privacy-erasure")).toContainText("no button for this yet");
});

// --- The browser-storage line (#179 follow-up) ---------------------------
// The notice states what stays on the visitor's device: no cookies, the
// session token and theme preference in localStorage, erasable by the user.
// The steps assert the RENDERED copy and key list, so a data change that never
// reaches the page fails here.

Then(
  "I see the browser-storage line: no cookies, localStorage keys, erasable",
  async ({ page }) => {
    const storage = page.getByTestId("about-privacy").getByTestId("about-privacy-storage");
    await expect(storage).toBeVisible();
    await expect(storage).toContainText("tidak memasang cookie");
    await expect(storage).toContainText("tanpa pelacakan");
    await expect(storage).toContainText("menghapusnya sendiri");
    // The keys named are the ones the app writes.
    await expect(storage).toContainText("kajianq.auth.token");
    await expect(storage).toContainText("kajianq.chat.sessionId");
    await expect(storage).toContainText("kajianq.theme");
  },
);

Then("I see the browser-storage line in English", async ({ page }) => {
  const storage = page.getByTestId("about-privacy").getByTestId("about-privacy-storage");
  await expect(storage).toContainText("sets no cookies");
  await expect(storage).toContainText("no tracking");
  await expect(storage).toContainText("erase them yourself");
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
  // The question follows the locale too, not only the label. The origin is
  // irrelevant: only the `q` param is asserted, so the base URL never couples
  // the step to a specific serving origin (thermo-review C1).
  const q = new URL((await link.getAttribute("href"))!, "http://example.com").searchParams.get("q");
  expect(q).toBe(FIRST_ASK_EN);
});

Then("the chat composer is empty", async ({ page }) => {
  await expect(page.getByTestId("composer")).toHaveValue("");
});
