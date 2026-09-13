// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleCtx } from "./i18n";
import { SwUpdatePrompt } from "./sw-update";

// React 19 + vitest: mark the environment for act() (render/act flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The PWA update-prompt flow (thermo-review C2, #143): a new service worker
 * that reaches "installed" while an OLD one still controls the page is the
 * one state where the user must be offered a reload — a stale bundle ships
 * silently otherwise. The prompt must stay hidden in every other state:
 * first install (no controller — nothing to upgrade from), mid-install,
 * redundant workers, and platforms without service-worker support at all.
 * Apply is the reload action itself (the component holds no skipWaiting or
 * postMessage surface — the new worker takes over on reload).
 */

type Listener = () => void;

/**
 * Minimal addEventListener host mimicking EventTarget for the two objects
 * the component subscribes to: the registration ("updatefound") and the
 * installing worker ("statechange"). The test drives state transitions by
 * firing these listeners explicitly.
 */
function makeListenerHost() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: vi.fn((type: string, cb: Listener) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    }),
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

type Host = ReturnType<typeof makeListenerHost>;
type WorkerMock = { state: string } & Host;
type RegMock = { installing: WorkerMock | null } & Host;

function makeWorker(state: string): WorkerMock {
  return { state, ...makeListenerHost() };
}

/**
 * Installs the mocked `navigator.serviceWorker` surface: `ready` resolving to
 * a registration with the given (optional) installing worker, and the given
 * controller (the old worker controlling the page, if any).
 */
function installSwMock(opts: { controller?: WorkerMock | null; installing?: WorkerMock }) {
  const reg = {
    installing: opts.installing ?? null,
    ...makeListenerHost(),
  } as RegMock;
  const sw = {
    controller: opts.controller ?? null,
    ready: Promise.resolve(reg),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  return { reg, sw };
}

/** Flush the `serviceWorker.ready` promise chain inside act(). */
async function flushReady() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Drive the update lifecycle: updatefound on the registration, then the worker's statechange. */
function fireUpdate(installing: WorkerMock) {
  act(() => {
    installing.fire("statechange");
    installing.state = "installed";
    installing.fire("statechange");
  });
}

afterEach(() => {
  cleanup();
  // jsdom's navigator has no `serviceWorker` own property; drop the mock so
  // tests that expect "no service-worker support" start from a clean slate.
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("SwUpdatePrompt", () => {
  it("renders nothing on platforms without service-worker support", async () => {
    // navigator.serviceWorker is already deleted by the afterEach above; the
    // guard must short-circuit before even touching `ready`.
    expect("serviceWorker" in navigator).toBe(false);
    render(createElement(SwUpdatePrompt));
    await flushReady();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing before any registration event fires", () => {
    installSwMock({ controller: makeWorker("activated") });
    render(createElement(SwUpdatePrompt));
    // `ready` resolved but no updatefound has fired — no prompt on mount.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    {
      name: "first install: new worker installed but no old controller",
      controller: null,
      state: "installed",
      visible: false,
    },
    {
      name: "old controller, new worker still installing",
      controller: makeWorker("activated"),
      state: "installing",
      visible: false,
    },
    {
      name: "old controller, new worker redundant",
      controller: makeWorker("activated"),
      state: "redundant",
      visible: false,
    },
    {
      name: "old controller, new worker installed (update ready)",
      controller: makeWorker("activated"),
      state: "installed",
      visible: true,
    },
  ])("$name", async ({ controller, state, visible }) => {
    const installing = makeWorker("installing");
    const { reg } = installSwMock({ controller, installing });
    render(createElement(SwUpdatePrompt));
    await flushReady();

    act(() => {
      reg.fire("updatefound");
      installing.state = state;
      installing.fire("statechange");
    });

    if (visible) {
      expect(screen.queryByRole("status")).not.toBeNull();
    } else {
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  it("ignores updatefound when no worker is installing", async () => {
    const { reg } = installSwMock({ controller: makeWorker("activated") });
    render(createElement(SwUpdatePrompt));
    await flushReady();

    act(() => {
      reg.fire("updatefound");
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the en prompt with a reload button that reloads the page", async () => {
    const installing = makeWorker("installing");
    const { reg } = installSwMock({ controller: makeWorker("activated"), installing });
    render(createElement(SwUpdatePrompt));
    await flushReady();

    act(() => {
      reg.fire("updatefound");
    });
    fireUpdate(installing);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Update available");
    // jsdom's Location#reload is not configurable — stub the whole
    // `window.location` with the one member the component calls.
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload } as unknown as Location,
      configurable: true,
      writable: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("renders the id locale copy under the id locale", async () => {
    const installing = makeWorker("installing");
    const { reg } = installSwMock({ controller: makeWorker("activated"), installing });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(LocaleCtx.Provider, { value: "id" }, children);
    render(createElement(SwUpdatePrompt), { wrapper });
    await flushReady();

    act(() => {
      reg.fire("updatefound");
    });
    fireUpdate(installing);

    expect(screen.getByRole("status").textContent).toContain("Pembaruan tersedia");
    expect(screen.getByRole("button", { name: "Muat ulang" })).not.toBeNull();
  });
});
