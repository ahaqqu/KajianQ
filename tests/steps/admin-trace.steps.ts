import { createBdd } from "playwright-bdd";
import { expect, type Page } from "@playwright/test";
import { E2E_ADMIN_PASSWORD } from "../support/admin-fixture";

/**
 * Admin Trace browser BDD.
 *
 * The sign-in is REAL: the page's probe, the CSRF bootstrap, the credential check
 * against `ADMIN_PASSWORD` and the cookie all run against the serving API — the suite
 * only stubs the trace data, which needs a database the e2e server does not have. So
 * the "closed until signed in" scenarios prove the deployed guard, not a fixture.
 *
 * This feature is tagged `@local` and filtered out of an external `E2E_BASE_URL` run by
 * `playwright.config.ts`: it drives an embedded host that the config boots with the
 * fixture credential below, so against an external host it would fail on a credential
 * and fixture rows that host does not have.
 */
const { Given, When, Then } = createBdd();

const PASSWORD = E2E_ADMIN_PASSWORD;

const RULING_TRACE = "11111111-1111-4111-8111-111111111111";
const RULING_MESSAGE = "22222222-2222-4222-8222-222222222222";
const RIBA_TRACE = "33333333-3333-4333-8333-333333333333";
const RIBA_MESSAGE = "44444444-4444-4444-8444-444444444444";

const totals = {
  tokensIn: 12,
  tokensOut: 34,
  latencyMs: 900,
  costMicroUsd: 42,
  estimated: false,
};

const rulingItem = {
  traceId: RULING_TRACE,
  messageId: RULING_MESSAGE,
  createdAt: 1_700_000_000_000,
  question: "Apa itu ayat kursi?",
  answer: "Ayat kursi adalah QS. 2:255.",
  intent: "ruling",
  models: ["embedder-stub", "generator-stub"],
  refused: false,
  filterRelaxed: false,
  totals,
};

const ribaItem = {
  ...rulingItem,
  traceId: RIBA_TRACE,
  messageId: RIBA_MESSAGE,
  question: "Apa itu riba?",
  answer: "Riba adalah tambahan yang diharamkan.",
};

/** The detail's frame: the same shape the chat's Trace panel reads. */
function detailOf(item: typeof rulingItem) {
  return {
    ...item,
    calls: [
      {
        stage: "retriever",
        modelId: "embedder-stub",
        purpose: "embed",
        tokensIn: 8,
        tokensOut: 0,
        latencyMs: 12,
        costMicroUsd: 7,
      },
      {
        stage: "generator",
        modelId: "generator-stub",
        purpose: "generate",
        tokensIn: 4,
        tokensOut: 34,
        latencyMs: 888,
        costMicroUsd: 35,
      },
    ],
    frame: {
      messageId: item.messageId,
      sources: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
      technical: {
        intent: item.intent,
        subQueries: ["apa itu"],
        chunks: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
        models: item.models,
      },
    },
  };
}

/** The trace endpoints only: `/admin/v1/session` is never intercepted. */
async function stubTraceData(page: Page): Promise<void> {
  await page.route("**/admin/v1/traces**", async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (last === "raw") {
      const id = segments.at(-2);
      const item = id === RIBA_TRACE ? ribaItem : rulingItem;
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="trace-${id}.json"`,
        },
        body: JSON.stringify({
          id,
          createdAt: item.createdAt,
          events: [
            { stage: "router", kind: "intent", detail: { intent: "ruling" }, at: 1 },
            {
              stage: "retriever",
              kind: "llm_call",
              detail: { purpose: "embed" },
              cost: {
                modelId: "embedder-stub",
                tokensIn: 8,
                tokensOut: 0,
                latencyMs: 12,
                costMicroUsd: 7,
              },
              at: 2,
            },
          ],
        }),
      });
      return;
    }
    if (last !== "traces") {
      const item = last === RIBA_TRACE ? ribaItem : rulingItem;
      await route.fulfill({ json: detailOf(item) });
      return;
    }
    const text = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = text.includes("riba") ? [ribaItem] : [rulingItem, ribaItem];
    await route.fulfill({
      json: { items, page: 1, pageSize: 20, total: items.length },
    });
  });
}

Given("the admin trace data is stubbed", async ({ page }) => {
  await stubTraceData(page);
});

When("I open the admin surface", async ({ page }) => {
  await page.goto("/admin");
});

Then("I am asked for the admin password", async ({ page }) => {
  await expect(page.getByTestId("admin-password")).toBeVisible();
});

Then("the trace list is not shown", async ({ page }) => {
  await expect(page.getByTestId("admin-traces")).toHaveCount(0);
  await expect(page.getByTestId("admin-detail")).toHaveCount(0);
});

Then("the public home page offers no link to the admin surface", async ({ page }) => {
  await page.goto("/");
  const adminLinks = await page.locator('a[href*="admin"]').count();
  expect(adminLinks).toBe(0);
});

When("I sign in with the admin password", async ({ page }) => {
  await page.getByTestId("admin-password").fill(PASSWORD);
  await page.getByTestId("admin-sign-in").click();
  // The list is the proof the session cookie was accepted.
  await expect(page.getByTestId("admin-traces")).toBeVisible();
});

When("I open the first answer in the list", async ({ page }) => {
  await page.getByTestId(`admin-trace-${RULING_MESSAGE}`).click();
  await expect(page.getByTestId("admin-detail")).toBeVisible();
});

Then("I see the answer's tokens, cost and latency", async ({ page }) => {
  await expect(page.getByTestId("admin-totals-tokens")).toHaveText("12 / 34");
  await expect(page.getByTestId("admin-totals-cost")).toHaveText("42");
  await expect(page.getByTestId("admin-totals-latency")).toHaveText("900");
});

Then("I see every provider call, the embedding included", async ({ page }) => {
  const calls = page.getByTestId("admin-calls");
  await expect(calls).toContainText("embedder-stub");
  await expect(calls).toContainText("generator-stub");
});

Then("the Trace panel shows the answer's sources", async ({ page }) => {
  await expect(page.getByTestId("trace-body")).toBeVisible();
  await expect(page.getByTestId("trace-sources")).toContainText("Al-Baqarah");
  // Read-only: the panel's feedback flags are a write, and this surface writes nothing.
  await expect(page.getByTestId("trace-flag-chunk-1")).toHaveCount(0);
});

Then("the stored trace downloads as JSON", async ({ page }) => {
  const downloadStarted = page.waitForEvent("download");
  await page.getByTestId("admin-raw-link").click();
  const download = await downloadStarted;
  // The browser received an attachment named after the trace: the link is the
  // stored artifact, not a page that renders it.
  expect(download.suggestedFilename()).toBe(`trace-${RULING_TRACE}.json`);
  // …and the body the session may read is the persisted trace itself.
  const body = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    return { status: response.status, text: await response.text() };
  }, `/admin/v1/traces/${RULING_TRACE}/raw`);
  expect(body.status).toBe(200);
  const parsed = JSON.parse(body.text) as { id: string; events: unknown[] };
  expect(parsed.id).toBe(RULING_TRACE);
  expect(parsed.events.length).toBeGreaterThan(0);
});

Then(
  "every admin read answers the same 401, with and without a forged cookie",
  async ({ request }) => {
    // The API client fixture holds no session cookie: the only thing that would let these
    // reads through is the guard, so removing it reddens here (the route then answers 503
    // from the unconfigured store wiring instead of the uniform 401).
    const reads = [
      "/admin/v1/traces",
      `/admin/v1/traces/${RULING_TRACE}`,
      `/admin/v1/traces/${RULING_TRACE}/raw`,
    ];
    for (const path of reads) {
      const refused = await request.get(path);
      expect(refused.status(), path).toBe(401);
      expect(await refused.json(), path).toEqual({ error: "unauthorized" });
    }
    // A forged session cookie is the same miss as no cookie at all.
    const forged = await request.get("/admin/v1/traces", {
      headers: { cookie: "kajianq_admin=v1.bogus.bogus" },
    });
    expect(forged.status()).toBe(401);
    expect(await forged.json()).toEqual({ error: "unauthorized" });
  },
);

When("I search the traces for {string}", async ({ page }, text: string) => {
  await page.getByTestId("admin-filter-q").fill(text);
  await page.getByTestId("admin-apply").click();
});

Then("only the answer mentioning riba is listed", async ({ page }) => {
  await expect(page.getByTestId(`admin-trace-${RIBA_MESSAGE}`)).toBeVisible();
  await expect(page.getByTestId(`admin-trace-${RULING_MESSAGE}`)).toHaveCount(0);
});
