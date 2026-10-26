// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { chooseLocale, renderApp } from "./app-test-utils";
import { COLLECTION_ENTRIES, byStatus } from "../lib/collections";
import { COLLECTION_AVAILABLE } from "../lib/collections-available";
import { CONTROLLER, ERASURE, RETENTION, SUB_PROCESSORS } from "../lib/privacy-notice";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no scrolling and no `scrollTo` at all, while the chat
// transcript's auto-scroll effect calls it unconditionally — re-stubbed before
// every test (a test that lands on "/" mounts ChatView).
beforeEach(() => {
  Element.prototype.scrollTo = () => {};
});
afterEach(cleanup);

/** The `q` seed an ask link's href carries, decoded as the browser would. */
function seedOf(link: HTMLElement): string {
  const href = link.getAttribute("href") ?? "";
  expect(href.startsWith("/")).toBe(true);
  const q = new URL(href, "http://localhost").searchParams.get("q");
  expect(q).not.toBeNull();
  return q!;
}

describe("CollectionPage", () => {
  it("renders both the available and the planned entries, each marked", async () => {
    await renderApp("/collection");
    expect(screen.getAllByTestId("collection-entry").length).toBe(COLLECTION_ENTRIES.length);

    // Counts are derived from the data module, not hard-coded: the data shape
    // contract is owned by `collections.test.ts`, so this test asserts the page
    // renders what the module declares, per section.
    const available = screen.getByTestId("collection-section-available");
    const planned = screen.getByTestId("collection-section-planned");
    const availableIds = byStatus(COLLECTION_ENTRIES, "available").map((entry) => entry.id);
    const plannedIds = byStatus(COLLECTION_ENTRIES, "planned").map((entry) => entry.id);
    expect(within(available).getAllByTestId("collection-entry").length).toBe(availableIds.length);
    expect(within(planned).getAllByTestId("collection-entry").length).toBe(plannedIds.length);

    // The available/planned distinction is a per-entry marker (badge + status
    // attribute), not only a section heading.
    for (const entry of within(available).getAllByTestId("collection-entry")) {
      expect(entry.getAttribute("data-status")).toBe("available");
    }
    for (const entry of within(planned).getAllByTestId("collection-entry")) {
      expect(entry.getAttribute("data-status")).toBe("planned");
    }
    // The pinned available sources from `collections.test.ts` are on the page.
    for (const id of ["quran-tanzil-uthmani", "hadith-sunnah-com"] as const) {
      const entry = COLLECTION_ENTRIES.find((candidate) => candidate.id === id)!;
      expect(
        within(available)
          .getAllByTestId("collection-entry")
          .some((node) => node.textContent?.includes(entry.title.id)),
        id,
      ).toBe(true);
    }
    expect(within(available).getAllByTestId("collection-status")[0]?.textContent).toBe("Tersedia");
    expect(within(planned).getAllByTestId("collection-status")[0]?.textContent).toBe(
      "Direncanakan",
    );
  });

  it("shows a planned entry's registered reference as muted mono text", async () => {
    await renderApp("/collection");
    const ghazali = screen
      .getAllByTestId("collection-entry")
      .find((entry) => entry.textContent?.includes("Al-Ghazali"));
    expect(ghazali).toBeDefined();
    expect(ghazali!.textContent).toContain("direncanakan · #33");
  });

  it("carries a one-line attribution on an available entry and none on a planned one", async () => {
    await renderApp("/collection");
    const available = screen.getByTestId("collection-section-available");
    const first = within(available).getAllByTestId("collection-entry")[0]!;
    expect(first.textContent).toContain("Atribusi:");
    const planned = within(screen.getByTestId("collection-section-planned")).getAllByTestId(
      "collection-entry",
    )[0]!;
    expect(planned.textContent).not.toContain("Atribusi:");
  });

  it("filters the list by category tab, in both directions", async () => {
    await renderApp("/collection");

    const tabs = screen.getAllByTestId("collection-filter");
    // All + one tab per category, and "All" starts pressed.
    expect(tabs.length).toBe(8);
    const all = tabs[0]!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(all.textContent).toBe("Semua");

    const tafsirTab = tabs.find((tab) => tab.textContent === "Tafsir")!;
    fireEvent.click(tafsirTab);
    expect(tafsirTab.getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("false");
    const tafsirEntries = screen.getAllByTestId("collection-entry");
    expect(tafsirEntries.length).toBeGreaterThan(0);
    for (const entry of tafsirEntries) expect(entry.getAttribute("data-status")).toBe("planned");

    const scriptureTab = tabs.find((tab) => tab.textContent === "Kitab Suci")!;
    fireEvent.click(scriptureTab);
    const scriptureEntries = screen.getAllByTestId("collection-entry");
    expect(scriptureEntries.length).toBe(3);
    expect(screen.getByTestId("collection-section-planned").textContent).toContain(
      "Belum ada apa pun di kategori ini.",
    );

    fireEvent.click(all);
    expect(screen.getAllByTestId("collection-entry").length).toBeGreaterThan(tafsirEntries.length);
  });

  it("renders the page copy in Indonesian by default and switches to English", async () => {
    await renderApp("/collection");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Koleksi");

    chooseLocale("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The collection");
    expect(screen.getByTestId("collection-section-available").textContent).toContain(
      "Available now",
    );
    expect(screen.getAllByTestId("collection-status")[0]?.textContent).toBe("Available");
  });

  /**
   * The "Ask about this source" affordance: available entries only, each a
   * typed router `Link` into the chat carrying that entry's own question in the
   * current locale as the `q` param. The link never auto-sends — the chat seeds
   * its composer draft (see `chat-prefill.test.ts` for the consumption half).
   */
  it("gives every available entry an Ask link carrying its question, and none to planned entries", async () => {
    await renderApp("/collection");

    const available = within(screen.getByTestId("collection-section-available"));
    const planned = within(screen.getByTestId("collection-section-planned"));
    const availableEntries = available.getAllByTestId("collection-entry");
    const plannedEntries = planned.getAllByTestId("collection-entry");
    const availableIds = byStatus(COLLECTION_ENTRIES, "available").map((entry) => entry.id);

    // One ask link per available entry, in order, each pointing at the chat
    // with that entry's own (Indonesian, the default locale) question.
    const links = available.getAllByTestId("collection-ask");
    expect(links.length).toBe(availableEntries.length);
    expect(links.length).toBe(availableIds.length);
    links.forEach((link, index) => {
      const question = COLLECTION_ENTRIES.find((e) => e.id === availableIds[index])!.ask!.id;
      expect(link.tagName).toBe("A");
      expect(link.textContent).toBe("Tanyakan sumber ini");
      // The router serializes the `q` search param into the href; read it back
      // the way the browser would (URLSearchParams decodes `+` as a space).
      expect(seedOf(link)).toBe(question);
    });

    // Planned entries never carry the affordance.
    expect(plannedEntries.length).toBeGreaterThan(0);
    expect(planned.queryAllByTestId("collection-ask").length).toBe(0);
  });

  it("switches the Ask link's label and question with the locale", async () => {
    await renderApp("/collection");
    const firstQuestion = COLLECTION_AVAILABLE[0]!.ask!;
    const link = () => screen.getAllByTestId("collection-ask")[0]!;

    expect(link().textContent).toBe("Tanyakan sumber ini");
    expect(seedOf(link())).toBe(firstQuestion.id);

    chooseLocale("en");
    expect(link().textContent).toBe("Ask about this source");
    expect(seedOf(link())).toBe(firstQuestion.en);
  });
});

describe("AboutPage", () => {
  it("renders the display hero, the mission and the three principles", async () => {
    await renderApp("/about");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Dibangun untuk membaca perlahan, bertanya dengan cermat, dan mengikuti sumbernya.",
    );
    expect(screen.getByTestId("about-mission").textContent).toContain("Misi");
    const principles = screen.getByTestId("about-principles");
    expect(
      within(principles)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Sebutkan sumbernya", "Jaga perbedaan", "Kenali batasnya"]);
  });

  it("states the privacy posture and links to the notice, not the register", async () => {
    await renderApp("/about");
    const summary = screen.getByTestId("about-privacy-summary");
    expect(summary.textContent).toContain("Privasi");
    expect(
      screen.getByRole("link", { name: "Baca pemberitahuan privasi" }).getAttribute("href"),
    ).toBe("/privacy");
    // The Art. 30 register has one home: the About page no longer duplicates it.
    expect(screen.queryByTestId("privacy-notice-processor")).toBeNull();
  });

  it("links its calls to action to the notice and the collection", async () => {
    await renderApp("/about");
    expect(
      screen.getByRole("link", { name: "Baca pemberitahuan privasi" }).getAttribute("href"),
    ).toBe("/privacy");
    expect(screen.getByRole("link", { name: "Telusuri koleksi" }).getAttribute("href")).toBe(
      "/collection",
    );
  });

  it("re-renders its copy in English after a locale switch", async () => {
    await renderApp("/about");
    chooseLocale("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Built for reading slowly, asking carefully, and following the sources.",
    );
    expect(screen.getByTestId("about-principles").textContent).toContain("Name the source");
    expect(screen.getByRole("link", { name: "Read the privacy notice" })).toBeTruthy();
  });
});

describe("PrivacyPage", () => {
  it("renders the notice from the register: controller, sub-processors, retention, erasure (#179)", async () => {
    await renderApp("/privacy");
    const privacy = screen.getByTestId("privacy-notice");
    expect(privacy.textContent).toContain("Privasi");

    // One card per register row, each carrying its status — netcup is the host
    // in use today, so the page is never false.
    const processors = within(privacy).getAllByTestId("privacy-notice-processor");
    expect(processors.length).toBe(SUB_PROCESSORS.length);
    expect(within(privacy).getByTestId("privacy-notice-controller").textContent).toContain(
      CONTROLLER.name,
    );
    const netcup = processors.find((card) => card.textContent?.includes("netcup GmbH"))!;
    expect(netcup.getAttribute("data-status")).toBe("current");
    expect(netcup.textContent).toContain("Dipakai hari ini");
    // The register rule and the tier/verdict pair are on the page, not only in
    // the data module.
    expect(privacy.textContent).toContain("data pribadi tidak pernah lewat tingkat gratis");
    expect(netcup.textContent).toContain("Berbayar · Boleh membawa data pribadi");

    // Retention rows. Every window stated is enforced by something live on the
    // host (Art. 30 §7 "Applied on the host"), so no row renders as planned and
    // none carries a ticket: claiming `planned` for enforced work understates
    // the protection as much as the reverse would overstate it.
    const retention = within(privacy).getAllByTestId("privacy-notice-retention-row");
    expect(retention.length).toBe(RETENTION.length);
    expect(
      retention.find((row) => row.textContent?.includes("30 hari tanpa aktivitas")),
    ).toBeDefined();
    for (const row of retention) {
      expect(row.getAttribute("data-status")).toBe("current");
      expect(row.textContent).not.toContain("direncanakan");
    }
    const accessLogs = retention.find((row) => row.textContent?.includes("Log akses"))!;
    expect(accessLogs.textContent).toContain("14 hari");
    expect(accessLogs.textContent).not.toContain("#180");

    // The erasure card names the real endpoint and the actual gap.
    const erasure = within(privacy).getByTestId("privacy-notice-erasure");
    expect(erasure.textContent).toContain(`${ERASURE.method} ${ERASURE.path}`);
    expect(erasure.textContent).toContain("belum punya tombol");
  });

  it("states the statutory rights and the CCPA opt-out anchor", async () => {
    await renderApp("/privacy");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Tanpa akun");
    expect(screen.getByText("Hak Anda")).toBeTruthy();
    expect(screen.getByText("Menghapus data Anda")).toBeTruthy();
    // The footer's opt-out link lands on a real anchor on this page.
    expect(document.querySelector("#do-not-sell")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Jangan Jual atau Bagikan" })).toBeTruthy();
  });

  it("switches the privacy notice to English with the locale (#179)", async () => {
    await renderApp("/privacy");
    chooseLocale("en");
    const privacy = screen.getByTestId("privacy-notice");
    expect(privacy.textContent).toContain("Who processes your data");
    expect(privacy.textContent).toContain("In use today");
    expect(privacy.textContent).toContain("Not for personal data");
    expect(within(privacy).getByTestId("privacy-notice-erasure").textContent).toContain(
      "no button for this yet",
    );
  });
});

describe("FaqPage", () => {
  it("renders one disclosure per question, in the reader's locale", async () => {
    await renderApp("/faq");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Pertanyaan, dijawab lugas.",
    );
    const questions = document.querySelectorAll("details");
    expect(questions.length).toBe(9);
    expect(questions[0]?.textContent).toContain("Apa itu KajianQ?");
    expect(questions[0]?.textContent).toContain("pendamping membaca literatur Islam klasik");
  });
});

describe("TermsPage", () => {
  it("renders the six sections and the operator's real contact channel", async () => {
    await renderApp("/terms");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Pendamping membaca, ditawarkan dengan itikad baik.",
    );
    const sections = document.querySelectorAll("section[class*='border-b']");
    expect(sections.length).toBe(6);
    expect(screen.getByText("Anda berbicara dengan mesin")).toBeTruthy();
    expect(document.body.textContent).toContain("@ahaqqu");
  });
});

describe("routes", () => {
  it("keeps the chat the home route and the health card on /health", async () => {
    await renderApp("/");
    expect(screen.getByTestId("chat-view")).toBeTruthy();

    cleanup();
    await renderApp("/health");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("KajianQ");
  });

  it("serves /about and /collection as distinct routes in the tree", async () => {
    await renderApp("/about");
    expect(screen.getByTestId("about-mission")).toBeTruthy();
    expect(screen.queryByTestId("collection-section-available")).toBeNull();

    cleanup();
    await renderApp("/collection");
    expect(screen.getByTestId("collection-section-available")).toBeTruthy();
    expect(screen.queryByTestId("about-mission")).toBeNull();
  });
});
