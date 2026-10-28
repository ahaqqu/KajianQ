// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./app-test-utils";

/**
 * The admin browser as an operator meets it, mounted on the real route tree.
 *
 * The two claims this file holds: the screen is behind the sign-in (no cookie, no
 * content), and the detail it shows is the chat's own Trace panel over the derived
 * frame — the totals, the raw download and the panel are the same answer the panel
 * renders, not a second rendering of the events. The last case asserts the other
 * half of the boundary: the public shell carries no link to this surface.
 */
const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

const listPayload = {
  items: [
    {
      traceId: TRACE_ID,
      messageId: MESSAGE_ID,
      createdAt: 1_700_000_000_000,
      question: "Apa itu ayat kursi?",
      answer: "Ayat kursi adalah QS. 2:255.",
      intent: "ruling",
      models: ["generator-stub"],
      refused: false,
      filterRelaxed: false,
      totals: {
        tokensIn: 12,
        tokensOut: 34,
        latencyMs: 900,
        costMicroUsd: 42,
        estimated: false,
      },
    },
  ],
  page: 1,
  pageSize: 20,
  total: 1,
};

const detailPayload = {
  ...listPayload.items[0],
  calls: [
    {
      stage: "retriever",
      modelId: "embedder-stub",
      purpose: "embed",
      tokensIn: 8,
      tokensOut: 0,
      latencyMs: 12,
      costMicroUsd: 7,
      // No mirror row names this model: an older trace whose model the config no
      // longer carries must render as unresolved, never as an unlabelled blank.
      modelConfig: { status: "unresolved", matches: [] },
    },
    {
      stage: "generator",
      modelId: "generator-stub",
      purpose: "generate",
      tokensIn: 4,
      tokensOut: 34,
      latencyMs: 888,
      costMicroUsd: 35,
      // 250,000/1,000,000 µUSD per MTok: ceil((4×0.25 + 34×1.0)) = 35, the recorded
      // figure — so the mirror explains the cost rather than replacing it.
      modelConfig: {
        status: "consistent",
        matches: [
          {
            provider: "provider-stub",
            roles: ["generator", "reviewer"],
            priceMicroUsdPerMTok: { in: 250_000, out: 1_000_000 },
            computedCostMicroUsd: 35,
            consistent: true,
          },
        ],
      },
    },
  ],
  frame: {
    messageId: MESSAGE_ID,
    sources: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
    technical: {
      intent: "ruling",
      subQueries: ["ayat kursi"],
      chunks: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
      models: ["embedder-stub", "generator-stub"],
    },
  },
};

type StubOptions = { authenticated: boolean; failLogout?: boolean };

function stubAdminApi({ authenticated, failLogout = false }: StubOptions) {
  // A session is the cookie the browser now holds: once the POST succeeds, every
  // later request is authenticated (the stub keeps the same state the cookie would).
  let signedIn = authenticated;
  let deletes = 0;
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (href.startsWith("/v1/admin/session")) {
      if (method === "DELETE") {
        // A failed logout leaves the cookie in place: the page must say what is true.
        if (failLogout && deletes++ === 0) return new Response(null, { status: 503 });
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (method === "POST") {
        signedIn = true;
        return Response.json({ authenticated: true, csrfToken: "csrf-2" });
      }
      return Response.json({ authenticated: signedIn, csrfToken: "csrf-1" });
    }
    if (!signedIn) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (/\/v1\/admin\/traces\/[^/]+$/.test(href)) return Response.json(detailPayload);
    if (href.includes("/v1/admin/traces")) return Response.json(listPayload);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000000" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin browser", () => {
  it("asks for the password before it reads anything", async () => {
    const fetchFn = stubAdminApi({ authenticated: false });
    await renderApp("/admin");
    expect(await screen.findByTestId("admin-password")).toBeTruthy();
    expect(screen.queryByTestId("admin-traces")).toBeNull();
    // No list request was made: the probe alone answered "signed out".
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("/traces"))).toHaveLength(0);
  });

  it("signs in, searches and opens the trace's totals, calls and stored JSON", async () => {
    const fetchFn = stubAdminApi({ authenticated: false });
    await renderApp("/admin");
    fireEvent.change(await screen.findByTestId("admin-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("admin-sign-in"));

    const row = await screen.findByTestId(`admin-trace-${MESSAGE_ID}`);
    expect(within(row).getByText("Apa itu ayat kursi?")).toBeTruthy();

    fireEvent.click(row);
    const detail = await screen.findByTestId("admin-detail");
    // The per-message totals, summed across the embedding and the generation call.
    expect(within(detail).getByTestId("admin-totals-tokens").textContent).toBe("12 / 34");
    expect(within(detail).getByTestId("admin-totals-cost").textContent).toBe("42");
    expect(within(detail).getByTestId("admin-totals-latency").textContent).toBe("900");
    // Every provider call is listed, embedding included.
    const calls = within(detail).getByTestId("admin-calls");
    expect(within(calls).getByText(/embedder-stub/)).toBeTruthy();
    expect(within(calls).getByText(/generator-stub/)).toBeTruthy();
    // The mirror explains the generation call — provider, roles, price — and says the
    // configured price reproduces the recorded figure…
    const generatorModel = within(calls).getByTestId("admin-call-model-1");
    expect(within(generatorModel).getByText(/provider-stub/)).toBeTruthy();
    expect(within(generatorModel).getByText(/generator, reviewer/)).toBeTruthy();
    // The shell is Indonesian-first, so the price is formatted in the reader's locale.
    expect(
      within(generatorModel).getByTestId("admin-call-match-1-provider-stub").textContent,
    ).toContain(
      `${new Intl.NumberFormat("id").format(250_000)} / ${new Intl.NumberFormat("id").format(1_000_000)}`,
    );
    expect(within(generatorModel).getByTestId("admin-call-consistency-1").textContent).toContain(
      "cocok dengan harga di konfigurasi",
    );
    // …while a call whose model the config no longer carries is explicit, not blank.
    expect(within(calls).getByTestId("admin-call-consistency-0").textContent).toContain(
      "tidak ada di konfigurasi penyedia",
    );
    // The stored artifact is a plain link the browser downloads.
    const raw = within(detail).getByTestId("admin-raw-link") as HTMLAnchorElement;
    expect(raw.getAttribute("href")).toBe(`/v1/admin/traces/${TRACE_ID}/raw`);
    // The panel is the chat's own Trace panel over the derived frame…
    expect(within(detail).getByTestId("trace-body")).toBeTruthy();
    // …in its read-only mode: no feedback flags.
    expect(within(detail).queryByTestId("trace-flag-chunk-1")).toBeNull();
    // The page is the SPA's `/admin` route; every data call goes to the API's
    // `/v1/admin` namespace, never to the old top-level path.
    expect(fetchFn.mock.calls.every(([url]) => !String(url).includes("/admin/v1"))).toBe(true);
  });

  it("keeps a usable CSRF token when logout fails, so the next sign-in is not refused", async () => {
    const fetchFn = stubAdminApi({ authenticated: true, failLogout: true });
    await renderApp("/admin");
    await screen.findByTestId("admin-traces");
    fireEvent.click(screen.getByTestId("admin-sign-out"));
    // The failed logout does not fabricate a signed-out state with an empty token: the
    // re-probe finds the session still live, so the page stays signed in and keeps a token
    // the next write can echo. (Seeding `csrfToken: ""` is what made every later sign-in
    // answer 401 and read as a wrong password.)
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/session"))).toBe(true),
    );
    expect(screen.getByTestId("admin-traces")).toBeTruthy();
    expect(screen.queryByTestId("admin-password")).toBeNull();
    // A later logout that succeeds signs the operator out normally…
    fireEvent.click(screen.getByTestId("admin-sign-out"));
    // …and the sign-in that follows carries a real token, not "".
    fireEvent.change(await screen.findByTestId("admin-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("admin-sign-in"));
    await screen.findByTestId("admin-traces");
    const post = fetchFn.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/v1/admin/session") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const headers = (post?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeTruthy();
    expect(headers["X-CSRF-Token"]).not.toBe("");
  });

  it("opens the answer named by the address bar (the deep link is a read)", async () => {
    stubAdminApi({ authenticated: true });
    await renderApp(`/admin?trace=${TRACE_ID}`);
    const detail = await screen.findByTestId("admin-detail");
    expect(within(detail).getByTestId("admin-detail-question").textContent).toBe(
      "Apa itu ayat kursi?",
    );
  });

  it("narrows the request when a filter is applied", async () => {
    const fetchFn = stubAdminApi({ authenticated: true });
    await renderApp("/admin");
    fireEvent.change(await screen.findByTestId("admin-filter-q"), {
      target: { value: "riba" },
    });
    fireEvent.click(screen.getByTestId("admin-apply"));
    await waitFor(() => {
      const urls = fetchFn.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes("/v1/admin/traces?q=riba"))).toBe(true);
    });
  });
});

describe("the public shell", () => {
  it("carries no link to the admin surface", async () => {
    stubAdminApi({ authenticated: false });
    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByRole("banner")).toBeTruthy();
    });
    const adminLinks = screen
      .queryAllByRole("link")
      .filter((link) => (link.getAttribute("href") ?? "").includes("admin"));
    expect(adminLinks).toEqual([]);
  });
});
