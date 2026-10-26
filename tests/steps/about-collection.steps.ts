import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

const { Before, When, Then } = createBdd();

/**
 * The About and Collection pages, and the header nav that reaches them. The
 * burger disclosure is asserted at a mobile viewport (the `< sm` breakpoint
 * collapses the inline nav), so the browser's real CSS decides the layout.
 */

// Belt-and-braces: it guarantees a desktop viewport even if the config moves to
// shared contexts or reordered scenarios.
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
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Dibangun untuk membaca perlahan",
  );
  await expect(page.getByTestId("about-mission")).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Built for reading slowly");
  await expect(page.getByTestId("about-principles")).toContainText("Name the source");
});

// --- The privacy notice ---------------------------------------------------
// The notice renders the register and the retention values, with the serving host
// marked in use today and the retired vendors kept as no-serving-role rows.

When("I see the privacy notice rendered from the register", async ({ page }) => {
  const notice = page.getByTestId("privacy-notice");
  await expect(notice).toContainText("Siapa yang memproses data Anda");
  await expect(notice.getByTestId("privacy-notice-controller")).toContainText("Angga (@ahaqqu)");
  // Every register row is its own card; the count is a floor, not the register size.
  const processors = notice.getByTestId("privacy-notice-processor");
  expect(await processors.count()).toBeGreaterThanOrEqual(7);
  await expect(notice).toContainText("netcup GmbH");
  await expect(notice).toContainText("Neon, Inc.");
  await expect(notice).toContainText("data pribadi tidak pernah lewat tingkat gratis");
  await expect(notice).toContainText("Bukan untuk data pribadi");
});

Then(
  "I see the netcup host marked as in use today, with the decommissioned vendors marked as having no serving role",
  async ({ page }) => {
    const netcup = page.getByTestId("privacy-notice-processor").filter({ hasText: "netcup GmbH" });
    await expect(netcup).toHaveAttribute("data-status", "current");
    await expect(netcup.getByTestId("privacy-notice-processor-status")).toHaveText(
      "Dipakai hari ini",
    );
    // Retired vendors stay registered — their history keeps its row — but each
    // says "no serving role".
    for (const vendor of ["Cloudflare, Inc.", "Neon, Inc."]) {
      const row = page.getByTestId("privacy-notice-processor").filter({ hasText: vendor });
      await expect(row).toHaveAttribute("data-status", "no-serving-role");
      await expect(row).toContainText("Tanpa peran melayani");
    }
  },
);

Then(
  "I see the retention row for reverse-proxy access logs marked {string}",
  async ({ page }, mark: string) => {
    const row = page
      .getByTestId("privacy-notice-retention-row")
      .filter({ hasText: "Log akses reverse proxy" });
    // The row renders as current — the logrotate stanza is applied on the host —
    // and it must not claim a ticket for work that is done.
    await expect(row).toHaveAttribute("data-status", "current");
    await expect(row).toContainText(mark);
    await expect(row).not.toContainText("#180");
    await expect(row).toContainText("14 hari");
  },
);

Then("the erasure card names the endpoint that erases the data", async ({ page }) => {
  const erasure = page.getByTestId("privacy-notice-erasure");
  await expect(erasure).toContainText("DELETE /v1/auth/me");
  await expect(erasure).toContainText(
    "sesi, sesi obrolan dan pesannya, trace setiap jawaban, dan masukan",
  );
  // The gap is stated, not papered over: there is no in-app erase button yet.
  await expect(erasure).toContainText("belum punya tombol");
});

Then("I see the privacy notice in English", async ({ page }) => {
  const notice = page.getByTestId("privacy-notice");
  await expect(notice).toContainText("Who processes your data");
  await expect(notice).toContainText("Not for personal data");
  await expect(notice.getByTestId("privacy-notice-erasure")).toContainText(
    "no button for this yet",
  );
});

// --- The browser-storage line --------------------------------------------
// The notice states what stays on the visitor's device: no cookies, the session
// token and theme preference in localStorage, erasable by the user.

Then(
  "I see the browser-storage line: no cookies, localStorage keys, erasable",
  async ({ page }) => {
    const storage = page.getByTestId("privacy-notice").getByTestId("privacy-notice-storage");
    await expect(storage).toBeVisible();
    await expect(storage).toContainText("tidak memasang cookie");
    await expect(storage).toContainText("tanpa pelacakan");
    await expect(storage).toContainText("menghapusnya sendiri");
    await expect(storage).toContainText("kajianq.auth.token");
    await expect(storage).toContainText("kajianq.chat.sessionId");
    await expect(storage).toContainText("kajianq.theme");
  },
);

Then("I see the browser-storage line in English", async ({ page }) => {
  const storage = page.getByTestId("privacy-notice").getByTestId("privacy-notice-storage");
  await expect(storage).toContainText("sets no cookies");
  await expect(storage).toContainText("no tracking");
  await expect(storage).toContainText("erase them yourself");
});

// --- "Ask about this source" affordance ----------------------------------
// The first available entry is the Uthmani Quran text, and its Indonesian question
// (the default locale) is pinned so the step asserts the data module's real copy.

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
  // The question follows the locale too, not only the label: only the `q` param
  // is asserted, so the step never couples to a serving origin.
  const q = new URL((await link.getAttribute("href"))!, "http://example.com").searchParams.get("q");
  expect(q).toBe(FIRST_ASK_EN);
});

Then("the chat composer is empty", async ({ page }) => {
  await expect(page.getByTestId("composer")).toHaveValue("");
});
