// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "./app-test-utils";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no scrolling and no `scrollTo` at all, while the chat
// transcript's auto-scroll effect calls it unconditionally — re-stubbed before
// every test (the active-state test lands on "/").
beforeEach(() => {
  Element.prototype.scrollTo = () => {};
});
afterEach(cleanup);

/**
 * The header nav carries three destinations (Chat, Collection, About), inline
 * on sm+ and behind a burger disclosure below it. jsdom applies no Tailwind
 * breakpoints, so both the inline nav and the burger button exist in the DOM;
 * these tests pin the disclosure contract (aria-expanded / aria-controls, a
 * localized label, links that navigate, close-on-navigate) rather than the CSS
 * visibility, and they assert the active link with TanStack's `aria-current`.
 */
describe("AppHeader navigation", () => {
  it("offers the three destinations, Indonesian-first", async () => {
    await renderApp("/about");
    const nav = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Obrolan", "Koleksi", "Tentang"]);
    expect(screen.getByTestId("nav-menu-toggle").getAttribute("aria-label")).toBe(
      "Buka menu navigasi",
    );
  });

  it("keeps the burger menu closed until the toggle is pressed", async () => {
    await renderApp("/about");
    const toggle = screen.getByTestId("nav-menu-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("primary-nav-menu");
    expect(screen.queryByTestId("nav-menu")).toBeNull();
  });

  it("opens and closes the disclosure menu from the toggle", async () => {
    await renderApp("/about");
    const toggle = screen.getByTestId("nav-menu-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Tutup menu navigasi");
    expect(screen.getByTestId("nav-menu")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Buka menu navigasi");
    expect(screen.queryByTestId("nav-menu")).toBeNull();
  });

  it("closes the disclosure on Escape and returns focus to the toggle", async () => {
    await renderApp("/about");
    const toggle = screen.getByTestId("nav-menu-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("nav-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("nav-menu")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes the disclosure when focus leaves the toggle+menu subtree", async () => {
    await renderApp("/about");
    const toggle = screen.getByTestId("nav-menu-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("nav-menu")).toBeTruthy();
    // Focus moves from a menu link to a control outside the disclosure (the
    // theme toggle) — the menu must close (thermo-review A3).
    const menuLink = within(screen.getByTestId("nav-menu")).getByRole("link", {
      name: "Koleksi",
    });
    fireEvent.focusOut(menuLink, { relatedTarget: screen.getByTestId("theme-toggle") });
    expect(screen.queryByTestId("nav-menu")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Moving focus between controls inside the disclosure keeps it open.
    fireEvent.click(toggle);
    fireEvent.focusOut(toggle, {
      relatedTarget: within(screen.getByTestId("nav-menu")).getByRole("link", {
        name: "Koleksi",
      }),
    });
    expect(screen.getByTestId("nav-menu")).toBeTruthy();
  });

  it("renders the same links inside the menu and closes it on navigation", async () => {
    const { router } = await renderApp("/about");
    fireEvent.click(screen.getByTestId("nav-menu-toggle"));
    const menu = screen.getByTestId("nav-menu");
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Obrolan", "Koleksi", "Tentang"]);
    fireEvent.click(within(menu).getByRole("link", { name: "Koleksi" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/collection"));
    await waitFor(() => expect(screen.queryByTestId("nav-menu")).toBeNull());
  });

  it("marks the current route active, and the home link only at the root", async () => {
    await renderApp("/about");
    let nav = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(nav).getByRole("link", { name: "Tentang" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Obrolan" }).getAttribute("aria-current"),
    ).toBeNull();

    cleanup();
    await renderApp("/");
    nav = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(nav).getByRole("link", { name: "Obrolan" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Koleksi" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("keeps the theme toggle and the language select on every route", async () => {
    await renderApp("/collection");
    expect(screen.getByTestId("theme-toggle")).toBeTruthy();
    const select = screen.getByTestId("locale-select") as HTMLSelectElement;
    expect(select.value).toBe("id");
    fireEvent.change(select, { target: { value: "en" } });
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Collection" })).toBeTruthy();
  });
});
