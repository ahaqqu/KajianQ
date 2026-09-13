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
 * one state where the user must be offered an update — a stale bundle ships
 * silently otherwise. The prompt must stay hidden in every other state:
 * first install (no controller — nothing to upgrade from), mid-install,
 * redundant workers, and platforms without service-worker support at all.
 * Apply posts SKIP_WAITING to the waiting worker (the generated sw.js
 * answers it with skipWaiting()) and reloads only on controllerchange, once
 * the new worker controls the page — a bare reload would leave the old
 * worker (and the stale bundle) in charge.
 */

type Listener = () => void;

/**
 * Minimal addEventListener host mimicking EventTarget for the three objects
 * the component subscribes to or acts on: the registration ("updatefound"),
 * the installing worker ("statechange"), and the service-worker container
 * ("controllerchange" — the takeover signal the apply path reloads on). The
 * test drives state transitions by firing these listeners explicitly.
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
type WorkerMock = { state: string; postMessage: (data: unknown) => void } & Host;
type RegMock = { installing: WorkerMock | null; waiting: WorkerMock | null } & Host;

function makeWorker(state: string): WorkerMock {
  return { state, postMessage: vi.fn(), ...makeListenerHost() };
}

/**
 * Installs the mocked `navigator.serviceWorker` surface: `ready` resolving to
 * a registration with the given (optional) installing/waiting workers, the
 * given controller (the old worker controlling the page, if any), and a
 * container that records controllerchange listeners.
 */
function installSwMock(opts: {
  controller?: WorkerMock | null;
  installing?: WorkerMock;
  waiting?: WorkerMock;
}) {
  const reg = {
    installing: opts.installing ?? null,
    waiting: opts.waiting ?? null,
    ...makeListenerHost(),
  } as RegMock;
  const sw = {
    controller: opts.controller ?? null,
    ready: Promise.resolve(reg),
    ...makeListenerHost(),
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

/**
 * Drive the update lifecycle: updatefound on the registration, then the
 * worker's statechange. Real statechange fires only AFTER the state property
 * has transitioned (the listener always reads the new value), so the state is
 * mutated before firing — matching the it.each table below.
 */
function fireUpdate(installing: WorkerMock) {
  act(() => {
    installing.state = "installed";
    installing.fire("statechange");
  });
}

// jsdom's `window.location` own property is re-definable, but its Location
// instance is not mockable member-by-member; tests that need to observe
// reload replace the whole property. Snapshot the original descriptor so
// afterEach can restore it instead of leaking the stub to later tests.
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

afterEach(() => {
  cleanup();
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
  // jsdom's navigator has no `serviceWorker` own property; drop the mock so
  // tests that expect "no service-worker support" start from a clean slate.
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("SwUpdatePrompt", () => {
  it("renders nothing on platforms without service-worker support", async () => {
    // jsdom's navigator has no `serviceWorker` property at all (nothing has
    // mocked it yet — afterEach runs after a test, never before this first
    // one); the guard must short-circuit before even touching `ready`.
    expect("serviceWorker" in navigator).toBe(false);
    render(createElement(SwUpdatePrompt));
    await flushReady();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing before any registration event fires", async () => {
    installSwMock({ controller: makeWorker("activated") });
    render(createElement(SwUpdatePrompt));
    // `ready` has resolved and the updatefound listener is attached, but no
    // registration event has fired yet — no prompt on mount.
    await flushReady();
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

  it("shows the en prompt with a reload button", async () => {
    const installing = makeWorker("installing");
    const { reg } = installSwMock({ controller: makeWorker("activated"), installing });
    render(createElement(SwUpdatePrompt));
    await flushReady();

    act(() => {
      reg.fire("updatefound");
    });
    fireUpdate(installing);

    expect(screen.getByRole("status").textContent).toContain("Update available");
    expect(screen.getByRole("button", { name: "Reload" })).not.toBeNull();
  });

  it("apply: posts SKIP_WAITING to the waiting worker and reloads once it takes control", async () => {
    const installing = makeWorker("installing");
    const waiting = makeWorker("installed");
    const { reg, sw } = installSwMock({
      controller: makeWorker("activated"),
      installing,
      waiting,
    });
    render(createElement(SwUpdatePrompt));
    await flushReady();

    act(() => {
      reg.fire("updatefound");
    });
    fireUpdate(installing);

    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload } as unknown as Location,
      configurable: true,
      writable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await flushReady();

    // The waiting worker is asked to activate (the generated sw.js answers
    // SKIP_WAITING with skipWaiting()), but the page is NOT reloaded yet —
    // a bare reload would still be served by the old worker.
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();

    // The new worker activates and takes control of the page — now reload.
    act(() => {
      sw.fire("controllerchange");
    });
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
