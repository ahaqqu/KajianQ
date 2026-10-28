import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createMemoryRateLimiter } from "@app/rate";
import { traceTotals, type Trace } from "@app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApi } from "../app";
import type { AssetFetcher } from "@app/hardening";

/**
 * The admin surface's integration tests over the real routes and the in-memory
 * store (ADR-0064).
 *
 * The invariant under test, in order of severity:
 *
 *  1. **nothing is readable without the credential** — every admin path answers the
 *     identical 401, including a surface with no credential configured at all, so
 *     the endpoint is not a probe for whether one exists;
 *  2. **the access log never carries content** — a search string typed against
 *     question text must not appear in the log, and the log is written before the
 *     rows are served (a failed write serves nothing);
 *  3. **the derived view is the chat panel's derivation**, and the totals it shows
 *     are the trace's own arithmetic — every provider call, embedding included.
 */

const PASSWORD = "correct horse battery staple";

let currentStore: ReturnType<typeof createMemoryRagStore> | null = null;
let storeReadCount = 0;

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    buildStoreWiring: () => {
      if (currentStore === null) throw new Error("admin test: no store bound");
      return { fullStore: currentStore, runStore: runStoreEffect };
    },
  };
});

// The database client lives behind the RagStore adapter: these tests never reach one.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("admin test: the database must not be reached");
    }
  },
}));

const spaHtml = "<!doctype html><html><body>SPA</body></html>";

function mockAssets(): AssetFetcher {
  return {
    fetch: async () =>
      new Response(spaHtml, { status: 200, headers: { "content-type": "text/html" } }),
  };
}

function adminEnv(appEnv = "development"): Record<string, unknown> {
  return { ASSETS: mockAssets(), ADMIN_PASSWORD: PASSWORD, APP_ENV: appEnv };
}

function api(opts: { adminLoginLimit?: number; adminLimit?: number } = {}) {
  return createApi({ limiter: createMemoryRateLimiter(), ...opts });
}

function cookieValue(response: Response, name: string): string {
  for (const entry of response.headers.getSetCookie()) {
    if (entry.startsWith(`${name}=`)) return entry.split(";")[0] ?? "";
  }
  return "";
}

/** The bootstrap: a CSRF token plus the cookie that must accompany it. */
async function csrf(instance: ReturnType<typeof api>, env: Record<string, unknown>) {
  const response = await instance.request("/admin/v1/session", {}, env);
  const body = (await response.json()) as { csrfToken: string; authenticated: boolean };
  return {
    token: body.csrfToken,
    authenticated: body.authenticated,
    cookie: cookieValue(response, "kajianq_admin_csrf"),
    response,
  };
}

type Session = { cookie: string; csrfToken: string };

/** A full login, returning the session cookie and the rotated CSRF token. */
async function login(
  instance: ReturnType<typeof api>,
  env: Record<string, unknown>,
  password = PASSWORD,
): Promise<{ session: Session | null; response: Response }> {
  const boot = await csrf(instance, env);
  const response = await instance.request(
    "/admin/v1/session",
    {
      method: "POST",
      headers: {
        cookie: boot.cookie,
        "x-csrf-token": boot.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
    },
    env,
  );
  if (response.status !== 200) return { session: null, response };
  const body = (await response.json()) as { csrfToken: string };
  return {
    session: { cookie: cookieValue(response, "kajianq_admin"), csrfToken: body.csrfToken },
    response,
  };
}

const CHUNK_TEXT = "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ";

type SeedOptions = {
  question?: string;
  answer?: string;
  intent?: string;
  refused?: boolean;
  filterRelaxed?: boolean;
  createdAt?: number;
  costMicroUsd?: number;
  latencyMs?: number;
};

/** Seed one answer: a chunk, a user question, an assistant answer, and its trace. */
async function seedAnswer(
  store: ReturnType<typeof createMemoryRagStore>,
  opts: SeedOptions = {},
): Promise<{ traceId: string; messageId: string }> {
  const session = await runStoreEffect<{ userId: string }>(store.createSession());
  const sessionId = await runStoreEffect<string>(
    store.createChatSession({ userId: session.userId }),
  );
  await runStoreEffect<string>(
    store.insertChatMessage({
      sessionId,
      role: "user",
      content: opts.question ?? "Apa itu ayat kursi?",
    }),
  );
  const parentId = await runStoreEffect<string>(
    store.insertDocParent({
      sourceKey: `src-${crypto.randomUUID()}`,
      title: "Al-Baqarah",
      metadata: {},
    }),
  );
  const chunkId = await runStoreEffect<string>(
    store.insertDocChild({
      parentId,
      embeddingPrimary: null,
      embeddingFallback: null,
      textRaw: CHUNK_TEXT,
      textAr: CHUNK_TEXT,
      textId: "Allah, tidak ada tuhan selain Dia.",
      metadata: { sourceType: "quran" },
      ordinal: 0,
    }),
  );
  const traceId = crypto.randomUUID();
  const cost = {
    // A cost record always names the model that made the call (ADR-0009): the
    // browser's "models" column is read from these ids, never from a config.
    modelId: "embedder-stub",
    tokensIn: 10,
    tokensOut: 4,
    latencyMs: opts.latencyMs ?? 100,
    costMicroUsd: opts.costMicroUsd ?? 30,
  };
  const events: unknown[] = [
    { stage: "router", kind: "intent", detail: { intent: opts.intent ?? "ruling" }, at: 1 },
    { stage: "router", kind: "subquery", detail: { text: "ayat kursi" }, at: 2 },
    // The embedding call rides its own event, exactly as serving writes it.
    { stage: "retriever", kind: "llm_call", detail: { purpose: "embed" }, cost, at: 3 },
    {
      stage: "retriever",
      kind: "retrieval",
      detail: { chunks: [{ id: chunkId, score: 0.03125 }] },
      at: 4,
    },
    {
      stage: "generator",
      kind: "llm_call",
      detail: { purpose: "generate" },
      cost: { ...cost, modelId: "generator-stub", tokensOut: 40 },
      at: 5,
    },
    ...(opts.refused === true
      ? [
          {
            stage: "generator",
            kind: "refusal",
            reason: "generator refusal",
            detail: { trigger: "generator_refusal" },
            at: 6,
          },
        ]
      : []),
    ...(opts.filterRelaxed === true
      ? [
          {
            stage: "retriever",
            kind: "filter_relaxed",
            detail: { dropped: { grade: ["sahih"] }, track: "primary", adopted: true },
            at: 7,
          },
        ]
      : []),
  ];
  const messageId = crypto.randomUUID();
  await runStoreEffect<string>(
    store.insertAnswerTrace({
      messageId,
      userId: session.userId,
      trace: {
        id: traceId,
        createdAt: opts.createdAt ?? 1_700_000_000_000,
        events,
      } as never,
    }),
  );
  await runStoreEffect<string>(
    store.insertChatMessage({
      // The answer's id is minted once and written to BOTH rows, exactly as the
      // chat route does: the transcript's id and the trace's message reference must
      // name the same message, which is the join this browser reads.
      id: messageId,
      sessionId,
      role: "assistant",
      content: opts.answer ?? "Ayat kursi adalah QS. 2:255.",
      answerTraceId: traceId,
    }),
  );
  return { traceId, messageId };
}

async function seededStore(
  seeds: SeedOptions[] = [{}],
): Promise<ReturnType<typeof createMemoryRagStore>> {
  const store = createMemoryRagStore();
  for (const seed of seeds) await seedAnswer(store, seed);
  currentStore = store;
  return store;
}

describe("admin auth: nothing is readable without the credential", () => {
  it("answers the identical 401 on every admin path without a session", async () => {
    await seededStore();
    const instance = api();
    const paths: [string, RequestInit | undefined][] = [
      ["/admin/v1/traces", undefined],
      ["/admin/v1/traces/00000000-0000-4000-8000-000000000000", undefined],
      ["/admin/v1/traces/00000000-0000-4000-8000-000000000000/raw", undefined],
      ["/admin/v1/session", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }],
    ];
    for (const [path, init] of paths) {
      const res = await instance.request(path, init, adminEnv());
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({ error: "unauthorized" });
      // No content of any kind rides the refusal.
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("reads as a miss even when no credential is configured", async () => {
    await seededStore();
    const instance = api();
    const res = await instance.request("/admin/v1/traces", {}, { ASSETS: mockAssets() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 for a garbage session cookie", async () => {
    await seededStore();
    const res = await api().request(
      "/admin/v1/traces",
      { headers: { cookie: "kajianq_admin=v1.bogus.bogus" } },
      adminEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("refuses the login without the CSRF pair", async () => {
    await seededStore();
    const instance = api();
    const boot = await csrf(instance, adminEnv());
    const noHeader = await instance.request(
      "/admin/v1/session",
      {
        method: "POST",
        headers: { cookie: boot.cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      },
      adminEnv(),
    );
    expect(noHeader.status).toBe(401);
    expect(noHeader.headers.getSetCookie()).toHaveLength(0);

    const wrongHeader = await instance.request(
      "/admin/v1/session",
      {
        method: "POST",
        headers: {
          cookie: boot.cookie,
          "x-csrf-token": "0".repeat(48),
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: PASSWORD }),
      },
      adminEnv(),
    );
    expect(wrongHeader.status).toBe(401);
    expect(wrongHeader.headers.getSetCookie()).toHaveLength(0);
  });

  it("refuses a cross-site login even with the correct CSRF pair and credential", async () => {
    await seededStore();
    const instance = api();
    const boot = await csrf(instance, adminEnv());
    const res = await instance.request(
      "/admin/v1/session",
      {
        method: "POST",
        headers: {
          cookie: boot.cookie,
          "x-csrf-token": boot.token,
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ password: PASSWORD }),
      },
      adminEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("answers the same 401 for a wrong credential", async () => {
    await seededStore();
    const instance = api();
    const { session, response } = await login(instance, adminEnv(), "wrong credential");
    expect(response.status).toBe(401);
    expect(session).toBeNull();
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("sets a separate httpOnly/SameSite=Strict session cookie scoped to /admin", async () => {
    await seededStore();
    const { session, response } = await login(api(), adminEnv());
    expect(response.status).toBe(200);
    expect(session?.cookie).toMatch(/^kajianq_admin=/);
    const setCookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith("kajianq_admin="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/admin");
    // development serves plain http on loopback: Secure is a staging/production
    // property, and it is asserted there below.
    expect(setCookie).not.toContain("Secure");
  });

  it("adds Secure to both cookies outside development", async () => {
    await seededStore();
    const env = adminEnv("production");
    const instance = api();
    const boot = await csrf(instance, env);
    expect(boot.response.headers.getSetCookie().join(" ")).toContain("Secure");
    const { response } = await login(instance, env);
    const cookies = response.headers.getSetCookie().join(" ");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Strict");
    expect(cookies).toContain("Secure");
  });

  it("rate-limits the login POST", async () => {
    await seededStore();
    const instance = api({ adminLoginLimit: 2 });
    const env = adminEnv();
    const attempt = async () => {
      const boot = await csrf(instance, env);
      return instance.request(
        "/admin/v1/session",
        {
          method: "POST",
          headers: {
            cookie: boot.cookie,
            "x-csrf-token": boot.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "wrong" }),
        },
        env,
      );
    };
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("keeps every admin path off the public OpenAPI document", async () => {
    await seededStore();
    const res = await api().request("/openapi.json", {}, adminEnv());
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).filter((path) => path.includes("admin"))).toEqual([]);
  });

  it("answers an unknown admin path with a JSON 404, never the SPA", async () => {
    await seededStore();
    const res = await api().request("/admin/v1/nope", {}, adminEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("admin list: the failure-search seam", () => {
  it("returns each message's own question and answer, with its trace totals", async () => {
    const store = await seededStore([
      { question: "Apa itu ayat kursi?", answer: "Ayat kursi adalah QS. 2:255.", costMicroUsd: 70 },
    ]);
    const { messageId } = (
      await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 }))
    ).rows[0]!;
    const { session } = await login(api(), adminEnv());
    const res = await api().request(
      "/admin/v1/traces",
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        messageId: string;
        question: string;
        answer: string;
        intent?: string;
        models: string[];
        totals: { tokensIn: number; tokensOut: number; costMicroUsd: number; latencyMs: number };
      }[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.messageId).toBe(messageId);
    expect(item.question).toBe("Apa itu ayat kursi?");
    expect(item.answer).toBe("Ayat kursi adalah QS. 2:255.");
    expect(item.intent).toBe("ruling");
    expect(item.models).toEqual(["embedder-stub", "generator-stub"]);
    // Two calls at 10 in / 4 and 10 in / 40 out, each 100 ms at 70 micro-USD: the
    // embedding call is summed exactly like the generation.
    expect(item.totals).toEqual({
      tokensIn: 20,
      tokensOut: 44,
      latencyMs: 200,
      costMicroUsd: 140,
      estimated: false,
    });
  });

  it("pages server-side and counts every matching row", async () => {
    await seededStore([
      { question: "first", createdAt: 1_700_000_000_000 },
      { question: "second", createdAt: 1_700_000_001_000 },
    ]);
    const { session } = await login(api(), adminEnv());
    const res = await api().request(
      "/admin/v1/traces?pageSize=1&page=1",
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    const body = (await res.json()) as { items: unknown[]; total: number; pageSize: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.pageSize).toBe(1);
  });

  it("narrows the list by free text, intent and cost", async () => {
    await seededStore([
      { question: "Apa itu riba?", answer: "Riba adalah tambahan.", costMicroUsd: 10 },
      { question: "Apa itu zakat?", answer: "Zakat adalah kewajiban.", costMicroUsd: 900 },
    ]);
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const list = async (query: string) => {
      const res = await instance.request(
        `/admin/v1/traces?${query}`,
        { headers: { cookie: session!.cookie } },
        adminEnv(),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { items: { question: string }[]; total: number };
    };
    expect((await list("q=riba")).items.map((item) => item.question)).toEqual(["Apa itu riba?"]);
    expect((await list("q=%25")).total).toBe(0);
    expect((await list("minCostMicroUsd=100")).total).toBe(1);
    expect((await list("minCostMicroUsd=100")).items[0]?.question).toBe("Apa itu zakat?");
    expect((await list("intent=factual")).total).toBe(0);
    expect((await list("refused=true")).total).toBe(0);
  });

  it("answers a malformed filter as a 400 and reads nothing", async () => {
    await seededStore();
    const instance = api();
    const { session } = await login(instance, adminEnv());
    storeReadCount = 0;
    currentStore = Object.assign(currentStore!, {
      listAdminTraces: (...args: unknown[]) => {
        storeReadCount += 1;
        return (createMemoryRagStore().listAdminTraces as (...a: unknown[]) => unknown)(...args);
      },
    }) as never;
    for (const query of ["pageSize=0", "pageSize=51", "page=0", "minCostMicroUsd=-1", "q="]) {
      const res = await instance.request(
        `/admin/v1/traces?${query}`,
        { headers: { cookie: session!.cookie } },
        adminEnv(),
      );
      expect(res.status, query).toBe(400);
    }
    expect(storeReadCount).toBe(0);
  });
});

describe("admin access log: append-only evidence that never carries content", () => {
  it("records the read before serving it, and never the search text", async () => {
    const store = await seededStore([{ question: "Apa itu ayat kursi rahasia?" }]);
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const secret = "ayat kursi rahasia";
    const res = await instance.request(
      `/admin/v1/traces?q=${encodeURIComponent(secret)}&intent=ruling&page=2&pageSize=5`,
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    const log = store.allAdminAccess();
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.route).toBe("traces.list");
    expect(entry.summary.textSearch).toBe(true);
    expect(entry.summary.intent).toBe("ruling");
    expect(entry.summary.page).toBe(2);
    expect(entry.summary.pageSize).toBe(5);
    expect(entry.actor).toMatch(/^[0-9a-f]{16}$/);
    // The trap: the search string is typed against question text, so a summary that
    // carried it would put a fragment of a question in the log. Nothing of the
    // question, the answer, or the search text may appear anywhere in the record.
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Apa itu");
    expect(JSON.stringify(entry.summary)).not.toContain("q=");
  });

  it("records a detail read by its opaque row id, and the raw read separately", async () => {
    const store = await seededStore();
    const { traceId } = (await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 })))
      .rows[0]!;
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const headers = { cookie: session!.cookie };
    expect(
      (await instance.request(`/admin/v1/traces/${traceId}`, { headers }, adminEnv())).status,
    ).toBe(200);
    expect(
      (await instance.request(`/admin/v1/traces/${traceId}/raw`, { headers }, adminEnv())).status,
    ).toBe(200);
    const routes = store.allAdminAccess().map((entry) => entry.route);
    expect(routes).toEqual(["traces.detail", "traces.raw"]);
    for (const entry of store.allAdminAccess()) {
      expect(entry.summary.traceId).toBe(traceId);
    }
  });

  it("fails closed: a read that cannot be logged serves nothing", async () => {
    const store = await seededStore();
    const broken = Object.assign(store, {
      recordAdminAccess: () => {
        throw new Error("log unavailable");
      },
    });
    currentStore = broken;
    const instance = api();
    const { session } = await login(instance, adminEnv());
    currentStore = Object.assign(store, {
      recordAdminAccess: () => {
        throw new Error("log unavailable");
      },
    });
    const res = await instance.request(
      "/admin/v1/traces",
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("admin_unavailable");
    // The one thing that must NOT be in a failed read: content.
    expect(body).not.toContain("Apa itu");
  });
});

describe("admin detail: the chat panel's derivation, every provider call", () => {
  it("derives the Trace frame through the shared derivation and lists every call", async () => {
    const store = await seededStore();
    const { traceId, messageId } = (
      await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 }))
    ).rows[0]!;
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const res = await instance.request(
      `/admin/v1/traces/${traceId}`,
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      messageId: string;
      question: string;
      answer: string;
      totals: { tokensIn: number; costMicroUsd: number; latencyMs: number };
      calls: { stage: string; purpose?: string }[];
      frame: {
        messageId: string;
        sources: { id: string; source?: string }[];
        technical: { chunks: unknown[] };
      };
    };
    expect(detail.messageId).toBe(messageId);
    expect(detail.question).toBe("Apa itu ayat kursi?");
    expect(detail.frame.messageId).toBe(messageId);
    // The chunk title resolved through the store join, as in the chat panel.
    expect(detail.frame.sources).toHaveLength(1);
    expect(detail.frame.sources[0]?.source).toBe("Al-Baqarah");
    // Every provider call is represented — the embedding one included.
    expect(detail.calls.map((call) => `${call.stage}:${call.purpose ?? ""}`)).toEqual([
      "retriever:embed",
      "generator:generate",
    ]);
    expect(detail.totals.costMicroUsd).toBe(60);
  });

  it("serves the persisted trace verbatim as a download", async () => {
    const store = await seededStore();
    const { traceId } = (await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 })))
      .rows[0]!;
    const stored = await runStoreEffect<Trace | null>(store.getAnswerTraceById(traceId));
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const res = await instance.request(
      `/admin/v1/traces/${traceId}/raw`,
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="trace-${traceId}.json"`,
    );
    const raw = (await res.json()) as Trace;
    // Byte-for-byte the persisted trace: the raw download is the artifact, not a
    // second projection of it.
    expect(raw).toEqual(stored);
    expect(traceTotals(raw).costMicroUsd).toBe(60);
  });

  it("answers 404 for an unknown and for an unrepresentable id, identically", async () => {
    await seededStore();
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const headers = { cookie: session!.cookie };
    for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
      const res = await instance.request(`/admin/v1/traces/${id}`, { headers }, adminEnv());
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("admin surface: the public product stays untouched", () => {
  it("keeps the anonymous Bearer session out of the admin surface and vice versa", async () => {
    const store = await seededStore();
    const session = await runStoreEffect<{ token: string }>(store.createSession());
    // A public Bearer token opens no admin read…
    const admin = await api().request(
      "/admin/v1/traces",
      { headers: { authorization: `Bearer ${session.token}` } },
      adminEnv(),
    );
    expect(admin.status).toBe(401);
    // …and an admin cookie opens no public read.
    const { session: adminSession } = await login(api(), adminEnv());
    const auth = await api().request(
      `/v1/chat/sessions/${crypto.randomUUID()}/messages`,
      { headers: { cookie: adminSession!.cookie } },
      adminEnv(),
    );
    expect(auth.status).toBe(401);
  });

  it("serves the admin page shell and still answers public routes", async () => {
    await seededStore();
    const page = await api().request("/admin", {}, adminEnv());
    expect(page.status).toBe(200);
    const health = await api().request("/v1/health", {}, adminEnv());
    expect(health.status).toBe(200);
  });
});
