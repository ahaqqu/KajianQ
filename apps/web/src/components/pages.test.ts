// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "./app-test-utils";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no scrolling and no `scrollTo` at all, while the chat
// transcript's auto-scroll effect calls it unconditionally — re-stubbed before
// every test (a test that lands on "/" mounts ChatView).
beforeEach(() => {
  Element.prototype.scrollTo = () => {};
});
afterEach(cleanup);

describe("CollectionPage", () => {
  it("renders both the available and the planned entries, each marked", async () => {
    await renderApp("/collection");
    expect(screen.getAllByTestId("collection-entry").length).toBeGreaterThan(5);

    const available = screen.getByTestId("collection-section-available");
    const planned = screen.getByTestId("collection-section-planned");
    expect(within(available).getAllByTestId("collection-entry").length).toBe(5);
    expect(within(planned).getAllByTestId("collection-entry").length).toBeGreaterThan(5);

    // The available/planned distinction is a per-entry marker (badge + status
    // attribute), not only a section heading.
    for (const entry of within(available).getAllByTestId("collection-entry")) {
      expect(entry.getAttribute("data-status")).toBe("available");
    }
    for (const entry of within(planned).getAllByTestId("collection-entry")) {
      expect(entry.getAttribute("data-status")).toBe("planned");
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
