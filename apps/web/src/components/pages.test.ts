// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "./app-test-utils";
import { COLLECTION_ENTRIES, byStatus } from "../lib/collections";
import { COLLECTION_AVAILABLE } from "../lib/collections-available";

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

    // Counts are derived from the data module, not hard-coded (thermo-review
    // B4): the data shape contract is owned by `collections.test.ts`; this
    // test asserts the page renders what the module declares, per section.
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

    fireEvent.change(screen.getByTestId("locale-select"), { target: { value: "en" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The collection");
    expect(screen.getByTestId("collection-section-available").textContent).toContain(
      "Available now",
    );
    expect(screen.getAllByTestId("collection-status")[0]?.textContent).toBe("Available");
  });

  /**
   * The "Ask about this source" affordance (#175): available entries only, each
   * a typed router `Link` into the chat carrying that entry's own question in
   * the current locale as the `q` param. The link never auto-sends — the chat
   * seeds its composer draft (see `chat-prefill.test.ts` for the consumption
   * half).
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

    fireEvent.change(screen.getByTestId("locale-select"), { target: { value: "en" } });
    expect(link().textContent).toBe("Ask about this source");
    expect(seedOf(link())).toBe(firstQuestion.en);
  });
});

describe("AboutPage", () => {
  it("renders the hero, mission, three principles and the privacy section", async () => {
    await renderApp("/about");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tentang KajianQ");
    expect(screen.getByTestId("about-mission").textContent).toContain("Misi");
    const principles = screen.getByTestId("about-principles");
    expect(
      within(principles)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Sebutkan sumbernya", "Jaga perbedaan", "Kenali batasnya"]);
    expect(screen.getByTestId("about-privacy").textContent).toContain("Privasi");
  });

  it("links its calls to action to the chat and the collection", async () => {
    await renderApp("/about");
    expect(screen.getByRole("link", { name: "Mulai obrolan" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Telusuri koleksi" }).getAttribute("href")).toBe(
      "/collection",
    );
  });

  it("re-renders its copy in English after a locale switch", async () => {
    await renderApp("/about");
    fireEvent.change(screen.getByTestId("locale-select"), { target: { value: "en" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("About KajianQ");
    expect(screen.getByTestId("about-principles").textContent).toContain("Name the source");
    expect(screen.getByRole("link", { name: "Start a chat" })).toBeTruthy();
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
