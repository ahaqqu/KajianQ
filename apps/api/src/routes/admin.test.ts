import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createMemoryRateLimiter } from "@app/rate";
import {
  computeCost,
  loadProviderConfig,
  modelConfigEntries,
  parseCandidateKey,
  StoreError,
  type ModelConfigEntry,
} from "@app/infra";
import { traceTotals, type AdminTraceCall, type Trace } from "@app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApi } from "../app";
import { ADMIN_API_PREFIX, ADMIN_COOKIE_PATH, ADMIN_LOGIN_PATH } from "../lib/admin-paths";
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
 *     are the trace's own arithmetic — every provider call, embedding included;
 *  4. **the detail never decorates a trace with a mirror that disagrees with the
 *     config** — a drifted mirror answers a 503 with no content, logs structurally,
 *     and leaves the raw download available.
 */

const PASSWORD = "correct horse battery staple";

let currentStore: ReturnType<typeof createMemoryRagStore> | null = null;
let storeReadCount = 0;
/** The Effect bridge the mocked wiring hands the routes. One test swaps it for the identity
 * to answer a store read the in-memory double cannot express as an Effect. */
let currentRunStore: typeof runStoreEffect = runStoreEffect;

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    buildStoreWiring: () => {
      if (currentStore === null) throw new Error("admin test: no store bound");
      return { fullStore: currentStore, runStore: currentRunStore };
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

/** The signed token inside the admin cookie (`name=token`). */
function sessionToken(cookie: string): string {
  return cookie.slice("kajianq_admin=".length);
}

/** The session id the signed payload names. Decoding without verifying is enough here:
 * the test holds the token the server just minted, and a tampered one is covered by the
 * 401 cases. */
function sessionJti(cookie: string): string {
  const payload = sessionToken(cookie).split(".")[1] ?? "";
  const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
  return (JSON.parse(json) as { jti: string }).jti;
}

/** A base64url payload, the way the token encodes one — for a tampered-token case. */
function encodePayload(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The bootstrap: a CSRF token plus the cookie that must accompany it. */
async function csrf(
  instance: ReturnType<typeof api>,
  env: Record<string, unknown>,
  url = "/v1/admin/session",
) {
  const response = await instance.request(url, {}, env);
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
    "/v1/admin/session",
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

/** The logout a signed-in operator performs: both cookies plus the echoed CSRF header. */
async function logout(
  instance: ReturnType<typeof api>,
  env: Record<string, unknown>,
  session: Session,
): Promise<Response> {
  return instance.request(
    "/v1/admin/session",
    {
      method: "DELETE",
      headers: {
        cookie: `${session.cookie}; kajianq_admin_csrf=${session.csrfToken}`,
        "x-csrf-token": session.csrfToken,
      },
    },
    env,
  );
}

/** A login POST with the caller's own headers, at the caller's own URL: the Origin and
 * scheme cases need to say where the browser thinks it is, not where the proxy sits. */
async function loginAttempt(
  instance: ReturnType<typeof api>,
  env: Record<string, unknown>,
  headers: Record<string, string> = {},
  url = "/v1/admin/session",
  password = PASSWORD,
): Promise<Response> {
  const boot = await csrf(instance, env, url);
  return instance.request(
    url,
    {
      method: "POST",
      headers: {
        cookie: boot.cookie,
        "x-csrf-token": boot.token,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ password }),
    },
    env,
  );
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
  /** The generator call's model identity and token counts, for the mirror cases. */
  generatorModelId?: string;
  generatorTokensIn?: number;
  generatorTokensOut?: number;
  /** The generator's recorded cost, when a case needs it to agree with the mirror. */
  generatorCostMicroUsd?: number;
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
      cost: {
        ...cost,
        modelId: opts.generatorModelId ?? "generator-stub",
        ...(opts.generatorTokensIn !== undefined ? { tokensIn: opts.generatorTokensIn } : {}),
        tokensOut: opts.generatorTokensOut ?? 40,
        ...(opts.generatorCostMicroUsd !== undefined
          ? { costMicroUsd: opts.generatorCostMicroUsd }
          : {}),
      },
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

/** The checked-in config's derived mirror rows — what a booted deployment holds. */
function mirrorEntries(): ModelConfigEntry[] {
  return modelConfigEntries(loadProviderConfig());
}

async function storeWithMirror(
  entries: readonly ModelConfigEntry[] = mirrorEntries(),
): Promise<ReturnType<typeof createMemoryRagStore>> {
  const store = createMemoryRagStore();
  await runStoreEffect(store.syncModelConfigs(entries));
  return store;
}

async function seededStore(
  seeds: SeedOptions[] = [{}],
): Promise<ReturnType<typeof createMemoryRagStore>> {
  const store = await storeWithMirror();
  for (const seed of seeds) await seedAnswer(store, seed);
  currentStore = store;
  return store;
}

describe("admin auth: nothing is readable without the credential", () => {
  it("answers the identical 401 on every admin path without a session", async () => {
    await seededStore();
    const instance = api();
    const paths: [string, RequestInit | undefined][] = [
      ["/v1/admin/traces", undefined],
      ["/v1/admin/traces/00000000-0000-4000-8000-000000000000", undefined],
      ["/v1/admin/traces/00000000-0000-4000-8000-000000000000/raw", undefined],
      ["/v1/admin/session", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }],
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
    const res = await instance.request("/v1/admin/traces", {}, { ASSETS: mockAssets() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 for a garbage session cookie", async () => {
    await seededStore();
    const res = await api().request(
      "/v1/admin/traces",
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
      "/v1/admin/session",
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
      "/v1/admin/session",
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
      "/v1/admin/session",
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

  it("checks Origin against the configured public origin, not the proxy-facing URL", async () => {
    await seededStore();
    const instance = api();
    // The browser is on https://chat.example.org while the API sees the reverse proxy's
    // plain-HTTP request URL: the configured public origin is the source of truth.
    const env = { ...adminEnv(), ALLOWED_ORIGINS: "https://chat.example.org" };
    const post = (origin: string) =>
      loginAttempt(
        instance,
        env,
        {
          origin,
        },
        "http://chat.example.org/v1/admin/session",
      );
    expect((await post("https://chat.example.org")).status).toBe(200);
    // A different host is refused…
    expect((await post("https://evil.example")).status).toBe(401);
    // …and the allowlist is exact: the proxy-facing scheme is not a public origin.
    expect((await post("http://chat.example.org")).status).toBe(401);
  });

  it("refuses a proxied https Origin unless ALLOWED_ORIGINS names it, whatever the client forwards", async () => {
    await seededStore();
    const instance = api();
    // ALLOWED_ORIGINS is the only source that can vouch for the browser's origin. The
    // API is a plain-HTTP listener behind the TLS proxy, so the request URL cannot: with
    // no configured origin every Origin-carrying login fails closed, and a client-supplied
    // X-Forwarded-Proto is a hop's scheme claim, not the caller's origin, so it must not
    // rescue a single one of these.
    const env = adminEnv();
    const post = (origin: string, headers: Record<string, string> = {}) =>
      loginAttempt(
        instance,
        env,
        {
          origin,
          ...headers,
        },
        "http://chat.example.org/v1/admin/session",
      );
    expect((await post("http://chat.example.org")).status).toBe(401);
    expect((await post("https://chat.example.org")).status).toBe(401);
    expect((await post("https://chat.example.org", { "x-forwarded-proto": "https" })).status).toBe(
      401,
    );
    expect((await post("https://evil.example", { "x-forwarded-proto": "https" })).status).toBe(401);
    // Configuring the public origin is what accepts that browser origin.
    const configured = await loginAttempt(
      api(),
      { ...adminEnv(), ALLOWED_ORIGINS: "https://chat.example.org" },
      { origin: "https://chat.example.org" },
      "http://chat.example.org/v1/admin/session",
    );
    expect(configured.status).toBe(200);
  });

  it("logs an origin refusal without the refused origin or the request host", async () => {
    await seededStore();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const res = await loginAttempt(api(), adminEnv(), { origin: "https://evil.example" });
      expect(res.status).toBe(401);
      const refused = lines.filter((line) => line.includes("admin.login_origin_refused"));
      expect(refused).toHaveLength(1);
      // The operator can tell this refusal from a wrong password; a caller cannot
      // write a chosen origin or the host into the log, and the response is unchanged.
      expect(refused[0]).not.toContain("evil.example");
      expect(refused[0]).not.toContain("localhost");
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a malformed login body the same way whether or not a credential is configured", async () => {
    await seededStore();
    // Two requests suffice to tell the states apart if the body verdict depends on the
    // credential: the bootstrap hands out the CSRF pair, and the malformed body is then
    // either a 400 (configured) or a 401 (not). Both must be the same miss.
    const probe = async (env: Record<string, unknown>) => {
      const instance = api();
      const boot = await csrf(instance, env);
      const attempt = (body: unknown) =>
        instance.request(
          "/v1/admin/session",
          {
            method: "POST",
            headers: {
              cookie: boot.cookie,
              "x-csrf-token": boot.token,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
          env,
        );
      return [await attempt({ nope: 1 }), await attempt({ password: "x".repeat(513) })];
    };
    const configured = await probe(adminEnv());
    const unconfigured = await probe({ ASSETS: mockAssets() });
    for (const response of [...configured, ...unconfigured]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      // …and a refused login never hands out a session.
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
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

  it("sets separate httpOnly/SameSite=Strict cookies scoped to /v1/admin", async () => {
    await seededStore();
    const instance = api();
    const { session, response } = await login(instance, adminEnv());
    expect(response.status).toBe(200);
    expect(session?.cookie).toMatch(/^kajianq_admin=/);
    const setCookies = response.headers.getSetCookie();
    for (const name of ["kajianq_admin", "kajianq_admin_csrf"]) {
      const entry = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
      expect(entry, name).toBeDefined();
      expect(entry).toContain("HttpOnly");
      expect(entry).toContain("SameSite=Strict");
      // Exactly the admin API prefix: `/admin` would never be sent to the moved API,
      // and `/v1` would attach the operator's credential to public chat routes.
      expect(entry).toMatch(/Path=\/v1\/admin(;|$)/);
    }
    // development serves plain http on loopback: Secure is a staging/production
    // property, and it is asserted there below.
    expect(setCookies.join(" ")).not.toContain("Secure");
    expect(ADMIN_COOKIE_PATH).toBe(ADMIN_API_PREFIX);
    // The logout clears at the same path: a mismatched clear leaves a live cookie in
    // the browser for the rest of its Max-Age.
    const logout = await instance.request(
      ADMIN_LOGIN_PATH,
      {
        method: "DELETE",
        headers: {
          cookie: `${session!.cookie}; ${cookieValue(response, "kajianq_admin_csrf")}`,
          "x-csrf-token": session!.csrfToken,
        },
      },
      adminEnv(),
    );
    expect(logout.status).toBe(204);
    const cleared = logout.headers.getSetCookie();
    expect(cleared).toHaveLength(2);
    for (const entry of cleared) expect(entry).toMatch(/Path=\/v1\/admin(;|$)/);
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
        "/v1/admin/session",
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
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("limits reads on the browsing budget, apart from the login's", async () => {
    await seededStore();
    const instance = api({ adminLimit: 3 });
    const env = adminEnv();
    // The bootstrap and the login spend the READ budget's first slot and the LOGIN
    // budget's first slot respectively: the two meters are separate namespaces.
    const boot = await csrf(instance, env);
    const signedIn = await instance.request(
      "/v1/admin/session",
      {
        method: "POST",
        headers: {
          cookie: boot.cookie,
          "x-csrf-token": boot.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: PASSWORD }),
      },
      env,
    );
    expect(signedIn.status).toBe(200);
    const headers = { cookie: cookieValue(signedIn, "kajianq_admin") };
    for (const expected of [200, 200]) {
      expect((await instance.request("/v1/admin/traces", { headers }, env)).status).toBe(expected);
    }
    const limited = await instance.request("/v1/admin/traces", { headers }, env);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("cache-control")).toBe("no-store");
    // The read budget is exhausted, yet a credential attempt still reaches the credential
    // check — the login has its own, tighter namespace and was not the meter that ran out.
    const attempt = await instance.request(
      "/v1/admin/session",
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
    expect(attempt.status).toBe(401);
  });

  it("keeps the admin budget disjoint from the public /v1 budget", async () => {
    await seededStore();
    const env = adminEnv();
    // An admin read must not spend the public chat meter...
    const publicBudget = createApi({ limiter: createMemoryRateLimiter(), limit: 1 });
    expect((await publicBudget.request("/v1/admin/traces", {}, env)).status).toBe(401);
    expect((await publicBudget.request("/v1/health", {}, env)).status).toBe(200);
    expect((await publicBudget.request("/v1/health", {}, env)).status).toBe(429);

    // ...and an exhausted public budget must not close the admin surface: an operator
    // paging through traces during a chat flood still reaches the credential check.
    const mixedBudget = createApi({
      limiter: createMemoryRateLimiter(),
      limit: 1,
      adminLimit: 2,
    });
    expect((await mixedBudget.request("/v1/health", {}, env)).status).toBe(200);
    expect((await mixedBudget.request("/v1/health", {}, env)).status).toBe(429);
    expect((await mixedBudget.request("/v1/admin/session", {}, env)).status).toBe(200);
  });

  it("keeps every admin path off the public OpenAPI document", async () => {
    await seededStore();
    const res = await api().request("/openapi.json", {}, adminEnv());
    const body = await res.text();
    const doc = JSON.parse(body) as { paths: Record<string, unknown> };
    // Neither a path nor the namespace string: the surface is invisible to a
    // generated client, not merely hidden from its list.
    expect(Object.keys(doc.paths).filter((path) => path.includes("admin"))).toEqual([]);
    expect(body).not.toContain(ADMIN_API_PREFIX);
  });

  it("answers every unknown admin path with an uncacheable JSON 404, never the SPA", async () => {
    await seededStore();
    const probes: [string, RequestInit | undefined][] = [
      // The bare namespace, a path under it, and a method no admin route serves all
      // fall to the catch-all, which answers a raw Response: the post-`next` header
      // is what makes these uncacheable, not Hono's prepared one.
      ["/v1/admin", undefined],
      ["/v1/admin/nope", undefined],
      ["/v1/admin/traces", { method: "POST", body: "{}" }],
    ];
    for (const [path, init] of probes) {
      const res = await api().request(path, init, adminEnv());
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });
});

describe("admin login: the declared media type is part of the boundary", () => {
  /** The login POST without a content type: a byte-array body is the one form the
   * platform does not label for the caller, which is what a raw client sends. */
  async function loginWithoutContentType(
    instance: ReturnType<typeof api>,
    env: Record<string, unknown>,
  ): Promise<Response> {
    const boot = await csrf(instance, env);
    const request = new Request("http://localhost/v1/admin/session", {
      method: "POST",
      headers: { cookie: boot.cookie, "x-csrf-token": boot.token },
      body: new TextEncoder().encode(JSON.stringify({ password: PASSWORD })),
    });
    return instance.fetch(request, env as never);
  }

  it("refuses a non-JSON declaration with the uniform 401, before reading the body", async () => {
    await seededStore();
    const instance = api();
    const env = adminEnv();
    const attempts: [string, Response][] = [];
    for (const contentType of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=----kajianq",
    ]) {
      const response = await loginAttempt(instance, env, { "content-type": contentType });
      attempts.push([contentType, response]);
    }
    attempts.push(["missing", await loginWithoutContentType(instance, env)]);
    // The wrong-password answer is the reference the body must be byte-identical to.
    const wrong = await loginAttempt(instance, env, {}, "/v1/admin/session", "wrong credential");
    const reference = await wrong.text();
    expect(wrong.status).toBe(401);

    for (const [label, response] of attempts) {
      expect(response.status, label).toBe(401);
      expect(await response.text(), label).toBe(reference);
      // A refused login never hands out a session, whatever it declared.
      expect(response.headers.getSetCookie(), label).toHaveLength(0);
    }
  });

  it("accepts application/json with a charset parameter", async () => {
    await seededStore();
    const instance = api();
    const response = await loginAttempt(instance, adminEnv(), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });

  it("keeps the documented 401s for a malformed body, an empty object and an oversized password", async () => {
    await seededStore();
    const instance = api();
    const env = adminEnv();
    const bodies = [
      "{not json",
      "{}",
      JSON.stringify({ password: "" }),
      JSON.stringify({ password: "x".repeat(513) }),
    ];
    const bodiesSeen: string[] = [];
    for (const body of bodies) {
      const boot = await csrf(instance, env);
      const response = await instance.request(
        "/v1/admin/session",
        {
          method: "POST",
          headers: {
            cookie: boot.cookie,
            "x-csrf-token": boot.token,
            "content-type": "application/json",
          },
          body,
        },
        env,
      );
      expect(response.status, body.slice(0, 20)).toBe(401);
      bodiesSeen.push(await response.text());
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    expect(new Set(bodiesSeen)).toEqual(new Set(['{"error":"unauthorized"}']));
  });
});

describe("admin session revocation: sign-out ends the token, not just the browser copy", () => {
  const list = (instance: ReturnType<typeof api>, env: Record<string, unknown>, session: Session) =>
    instance.request("/v1/admin/traces?pageSize=1", { headers: { cookie: session.cookie } }, env);

  it("replaying the pre-logout cookie answers the same 401, and spends no audit row", async () => {
    const store = await seededStore();
    const traceId = (await runStoreEffect(store.listAdminTraces({}, { limit: 1, offset: 0 })))
      .rows[0]!.traceId;
    const instance = api();
    const env = adminEnv();
    const { session } = await login(instance, env);
    expect((await list(instance, env, session!)).status).toBe(200);
    const logged = store.allAdminAccess().length;
    expect(logged).toBe(1);

    const cleared = await logout(instance, env, session!);
    expect(cleared.status).toBe(204);
    expect(cleared.headers.getSetCookie()).toHaveLength(2);

    // The replay the sign-out invariant exists for: the cookie captured before logout.
    // Every read and the probe itself must read the session as ended, with one body.
    const replayPaths = [
      "/v1/admin/traces?pageSize=1",
      `/v1/admin/traces/${traceId}`,
      `/v1/admin/traces/${traceId}/raw`,
    ];
    for (const path of replayPaths) {
      const replay = await instance.request(path, { headers: { cookie: session!.cookie } }, env);
      expect(replay.status, path).toBe(401);
      expect(await replay.json(), path).toEqual({ error: "unauthorized" });
      expect(replay.headers.get("cache-control"), path).toBe("no-store");
    }
    const probe = await instance.request(
      "/v1/admin/session",
      { headers: { cookie: session!.cookie } },
      env,
    );
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { authenticated: boolean }).authenticated).toBe(false);
    // A refused read is not an audit: the replayed misses wrote nothing.
    expect(store.allAdminAccess()).toHaveLength(logged);
  });

  it("ends only the session that signed out: a second live session keeps working", async () => {
    const store = await seededStore();
    const instance = api();
    const env = adminEnv();
    const first = (await login(instance, env)).session!;
    const second = (await login(instance, env)).session!;
    expect(sessionJti(first.cookie)).not.toBe(sessionJti(second.cookie));
    expect((await logout(instance, env, first)).status).toBe(204);

    expect((await list(instance, env, first)).status).toBe(401);
    expect((await list(instance, env, second)).status).toBe(200);
    // Only the signed-out id is on the denylist.
    expect(await runStoreEffect(store.isAdminSessionRevoked(sessionJti(first.cookie)))).toBe(true);
    expect(await runStoreEffect(store.isAdminSessionRevoked(sessionJti(second.cookie)))).toBe(
      false,
    );
  });

  it("answers 204 and clears both cookies for an absent or forged token", async () => {
    await seededStore();
    const instance = api();
    const env = adminEnv();
    for (const cookie of [undefined, "kajianq_admin=v1.forged.signature"]) {
      const boot = await csrf(instance, env);
      const csrfCookie = cookieValue(boot.response, "kajianq_admin_csrf");
      const headers: Record<string, string> = {
        cookie: cookie === undefined ? csrfCookie : `${cookie}; ${csrfCookie}`,
        "x-csrf-token": boot.token,
      };
      const response = await instance.request(
        "/v1/admin/session",
        { method: "DELETE", headers },
        env,
      );
      // Nothing to revoke is still a completed sign-out: the miss stays uniform.
      expect(response.status, cookie).toBe(204);
      expect(response.headers.getSetCookie(), cookie).toHaveLength(2);
    }
  });

  it("purges an expiry-passed revocation row, and a token with that id lives again", async () => {
    // The retention property: a row outlives its token by design, then is pruned. Because
    // the id is random, the "same id" half is exercised by the token the row named — a
    // future token never reuses it.
    const store = await seededStore();
    const instance = api();
    const env = adminEnv();
    const { session } = await login(instance, env);
    const jti = sessionJti(session!.cookie);
    await runStoreEffect(store.revokeAdminSession({ jti, expiresAt: Date.now() - 60_000 }));
    expect((await list(instance, env, session!)).status).toBe(401);
    expect(await runStoreEffect(store.purgeAdminSessionRevocations())).toBe(1);
    expect(await runStoreEffect(store.isAdminSessionRevoked(jti))).toBe(false);
    expect((await list(instance, env, session!)).status).toBe(200);

    // An unexpired row is not pruned, and keeps blocking; a newer login is a new id.
    const second = (await login(instance, env)).session!;
    await runStoreEffect(
      store.revokeAdminSession({
        jti: sessionJti(second.cookie),
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(await runStoreEffect(store.purgeAdminSessionRevocations())).toBe(0);
    expect((await list(instance, env, second)).status).toBe(401);
    const third = (await login(instance, env)).session!;
    expect(sessionJti(third.cookie)).not.toBe(jti);
    expect((await list(instance, env, third)).status).toBe(200);
  });

  it("reads a malformed or tampered session id as a normal 401, never an error", async () => {
    await seededStore();
    const instance = api();
    const env = adminEnv();
    const { session } = await login(instance, env);
    const [version, payload, signature] = sessionToken(session!.cookie).split(".");
    const decoded = JSON.parse(atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp: number;
      jti: string;
    };
    const replaced = encodePayload({ exp: decoded.exp, jti: "A".repeat(22) });
    const candidates = [
      // A well-formed but never-issued id with the old signature: tampering.
      `${version}.${replaced}.${signature}`,
      // A payload with no session id at all: a token that could never be revoked.
      `${version}.${encodePayload({ exp: decoded.exp })}.${signature}`,
      "v1.bogus.bogus",
      "",
    ];
    for (const candidate of candidates) {
      const response = await instance.request(
        "/v1/admin/traces",
        { headers: { cookie: `kajianq_admin=${candidate}` } },
        env,
      );
      expect(response.status, candidate).toBe(401);
      expect(await response.json(), candidate).toEqual({ error: "unauthorized" });
    }
  });

  it("fails closed when the revocation store cannot answer, and a failed write is not 204", async () => {
    const store = await seededStore();
    const instance = api();
    const env = adminEnv();
    const { session } = await login(instance, env);
    currentStore = Object.assign(store, {
      isAdminSessionRevoked: () => {
        throw new Error("denylist unavailable");
      },
    }) as never;
    const read = await instance.request(
      "/v1/admin/traces",
      { headers: { cookie: session!.cookie } },
      env,
    );
    expect(read.status).toBe(503);
    expect(await read.text()).toContain("admin_unavailable");
    const probe = await instance.request(
      "/v1/admin/session",
      { headers: { cookie: session!.cookie } },
      env,
    );
    expect(((await probe.json()) as { authenticated: boolean }).authenticated).toBe(false);

    currentStore = Object.assign(store, {
      revokeAdminSession: () => {
        throw new Error("denylist unavailable");
      },
    }) as never;
    const logoutResponse = await logout(instance, env, session!);
    // A 204 here would report a sign-out that did not happen; the cookie must stay.
    expect(logoutResponse.status).toBe(503);
    expect(logoutResponse.headers.getSetCookie()).toHaveLength(0);
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
      "/v1/admin/traces",
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
      "/v1/admin/traces?pageSize=1&page=1",
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
        `/v1/admin/traces?${query}`,
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
        `/v1/admin/traces?${query}`,
        { headers: { cookie: session!.cookie } },
        adminEnv(),
      );
      expect(res.status, query).toBe(400);
      expect(res.headers.get("cache-control"), query).toBe("no-store");
    }
    expect(storeReadCount).toBe(0);
  });

  it("refuses a NUL or control character in the filter before the log write and the read", async () => {
    const store = await seededStore([{ question: "Apa itu ayat kursi?" }]);
    const instance = api();
    const { session } = await login(instance, adminEnv());
    let listReads = 0;
    const readTraces = store.listAdminTraces.bind(store);
    currentStore = Object.assign(store, {
      listAdminTraces: (...args: Parameters<typeof readTraces>) => {
        listReads += 1;
        return readTraces(...args);
      },
    }) as never;

    // `%00` is the URL-decoded NUL that reached the store as a bound parameter. The
    // others are the same class — an embedded NUL, a C0 character, DEL — and every one
    // must be the documented 400, never the 500 a bound NUL produces in the store.
    for (const q of ["%00", "ayat%00kursi", "ayat%07kursi", "%7F"]) {
      const res = await instance.request(
        `/v1/admin/traces?q=${q}&pageSize=5`,
        { headers: { cookie: session!.cookie } },
        adminEnv(),
      );
      expect(res.status, q).toBe(400);
      expect(await res.json(), q).toEqual({ error: "invalid_request" });
      expect(res.headers.get("cache-control"), q).toBe("no-store");
    }
    // Neither side effect was spent on a refused filter: no audit row, no content read.
    expect(store.allAdminAccess()).toHaveLength(0);
    expect(listReads).toBe(0);

    // The adjacent adversarial shapes keep their answers: injection-shaped text is an
    // ordinary empty match, and the length ceiling is still a 400.
    for (const q of ["' OR 1=1--", "'; DROP TABLE answer_traces;--"]) {
      const res = await instance.request(
        `/v1/admin/traces?q=${encodeURIComponent(q)}`,
        { headers: { cookie: session!.cookie } },
        adminEnv(),
      );
      expect(res.status, q).toBe(200);
      expect(((await res.json()) as { total: number }).total, q).toBe(0);
    }
    const overLong = await instance.request(
      `/v1/admin/traces?q=${"x".repeat(201)}`,
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(overLong.status).toBe(400);
    // The two valid searches above are the only rows this test spends.
    expect(store.allAdminAccess()).toHaveLength(2);
  });
});

describe("admin access log: append-only evidence that never carries content", () => {
  it("records the read before serving it, and never the search text", async () => {
    const store = await seededStore([{ question: "Apa itu ayat kursi rahasia?" }]);
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const secret = "ayat kursi rahasia";
    const res = await instance.request(
      `/v1/admin/traces?q=${encodeURIComponent(secret)}&intent=ruling&page=2&pageSize=5`,
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    const log = store.allAdminAccess();
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.route).toBe("traces.list");
    expect(entry.summary.textSearch).toBe(true);
    // The intent filter is recorded as presence: `intent` is a bounded operator string, not a
    // closed vocabulary, so its value is free text exactly like the search text.
    expect(entry.summary.intentFiltered).toBe(true);
    expect(entry.summary.page).toBe(2);
    expect(entry.summary.pageSize).toBe(5);
    expect(entry.actor).toMatch(/^[0-9a-f]{16}$/);
    // The trap: the search string is typed against question text, so a summary that
    // carried it would put a fragment of a question in the log. Nothing of the
    // question, the answer, or the search text may appear anywhere in the record.
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Apa itu");
    expect(serialized).not.toContain("ruling");
    expect(JSON.stringify(entry.summary)).not.toContain("q=");
    // Every value in a list summary is a boolean or a bounded number: the free-text
    // filters are recorded as presence, so no future projection can smuggle the operator's
    // string through one. (The type alone does not enforce this — a detail read's summary
    // carries the opaque trace row id — so the projection is the guard this test pins.)
    for (const [key, value] of Object.entries(entry.summary)) {
      expect(["boolean", "number"], key).toContain(typeof value);
    }
  });

  it("records a detail read by its opaque row id, and the raw read separately", async () => {
    const store = await seededStore();
    const { traceId } = (await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 })))
      .rows[0]!;
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const headers = { cookie: session!.cookie };
    expect(
      (await instance.request(`/v1/admin/traces/${traceId}`, { headers }, adminEnv())).status,
    ).toBe(200);
    expect(
      (await instance.request(`/v1/admin/traces/${traceId}/raw`, { headers }, adminEnv())).status,
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
      "/v1/admin/traces",
      { headers: { cookie: session!.cookie } },
      adminEnv(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
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
      `/v1/admin/traces/${traceId}`,
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

  it("serves a stored shape the contract rejects as a raw download, and names it on detail", async () => {
    const store = await seededStore();
    const row = (await runStoreEffect(store.listAdminTraces({}, { limit: 1, offset: 0 }))).rows[0]!;
    // The adapter maps an unparseable stored trace to a `constraint` StoreError on the
    // structured read; the raw read hands the stored value back untouched. Both halves are
    // what the operator's escape hatch means, so neither may answer a generic 500.
    currentStore = Object.assign(store, {
      // The identity bridge below resolves plain values, so the revocation check is
      // answered as the boolean the seam promises rather than as an Effect.
      isAdminSessionRevoked: () => false,
      // The adapter raises this typed failure when the stored JSONB does not parse; the
      // double raises it directly, which is the branch the route has to answer.
      getAdminTrace: () => {
        throw new StoreError({ kind: "constraint", cause: new Error("does not parse") });
      },
      // The raw read's value, handed over unparsed; the identity bridge below resolves it.
      getAdminTraceRaw: () => ({ trace: { nope: true }, row }),
      // The mirror read is a resolved value for the identity bridge too: the drift gate
      // runs before the trace read this case is about, and it must see a current mirror.
      listModelConfigs: () => store.allModelConfigs(),
    });
    currentRunStore = (async (effect: unknown) => effect) as typeof runStoreEffect;
    try {
      const instance = api();
      const { session } = await login(instance, adminEnv());
      const headers = { cookie: session!.cookie };
      const detail = await instance.request(
        `/v1/admin/traces/${row.traceId}`,
        { headers },
        adminEnv(),
      );
      expect(detail.status).toBe(422);
      expect(await detail.json()).toEqual({ error: "trace_unparseable" });
      expect(detail.headers.get("cache-control")).toBe("no-store");
      const raw = await instance.request(
        `/v1/admin/traces/${row.traceId}/raw`,
        { headers },
        adminEnv(),
      );
      expect(raw.status).toBe(200);
      expect(await raw.json()).toEqual({ nope: true });
    } finally {
      currentRunStore = runStoreEffect;
    }
  });

  it("serves the persisted trace verbatim as a download", async () => {
    const store = await seededStore();
    const { traceId } = (await runStoreEffect(store.listAdminTraces({}, { limit: 10, offset: 0 })))
      .rows[0]!;
    const stored = await runStoreEffect<Trace | null>(store.getAnswerTraceById(traceId));
    const instance = api();
    const { session } = await login(instance, adminEnv());
    const res = await instance.request(
      `/v1/admin/traces/${traceId}/raw`,
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
      const res = await instance.request(`/v1/admin/traces/${id}`, { headers }, adminEnv());
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("admin detail: model identity and cost consistency from the mirror", () => {
  /** A generator call on a real config model with its price's own cost figure. */
  async function consistentSeed(): Promise<{
    store: ReturnType<typeof createMemoryRagStore>;
    provider: string;
    modelId: string;
    price: { in: number; out: number };
    expected: number;
  }> {
    const config = loadProviderConfig();
    const candidate = config.roles.generator?.chain[0];
    if (candidate === undefined) throw new Error("admin test: the generator chain is empty");
    const [provider, modelId] = parseCandidateKey(candidate);
    const model = config.vendors[provider]?.models[modelId];
    if (model === undefined)
      throw new Error("admin test: the generator candidate does not resolve");
    const expected = computeCost(modelId, model.priceMicroUsdPerMTok, 10, 7, 100).costMicroUsd;
    const store = await seededStore([
      {
        generatorModelId: modelId,
        generatorTokensIn: 10,
        generatorTokensOut: 7,
        generatorCostMicroUsd: expected,
      },
    ]);
    return { store, provider, modelId, price: model.priceMicroUsdPerMTok, expected };
  }

  async function detailOf(store: ReturnType<typeof createMemoryRagStore>): Promise<{
    headers: Record<string, string>;
    traceId: string;
    instance: ReturnType<typeof api>;
  }> {
    const { traceId } = (await runStoreEffect(store.listAdminTraces({}, { limit: 1, offset: 0 })))
      .rows[0]!;
    const instance = api();
    const { session } = await login(instance, adminEnv());
    return { headers: { cookie: session!.cookie }, traceId, instance };
  }

  it("reports a consistent configured price without replacing the recorded cost", async () => {
    const { store, provider, modelId, price, expected } = await consistentSeed();
    const { headers, traceId, instance } = await detailOf(store);
    const res = await instance.request(`/v1/admin/traces/${traceId}`, { headers }, adminEnv());
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { calls: AdminTraceCall[] };
    const call = detail.calls.find((entry) => entry.stage === "generator")!;
    // The recorded figure stays the call's cost…
    expect(call.costMicroUsd).toBe(expected);
    expect(call.modelConfig.status).toBe("consistent");
    const match = call.modelConfig.matches.find((entry) => entry.provider === provider)!;
    expect(match.roles).toContain("generator");
    expect(match.priceMicroUsdPerMTok).toEqual(price);
    expect(match.computedCostMicroUsd).toBe(expected);
    expect(match.consistent).toBe(true);
    // …and the trace is not otherwise changed by carrying the mirror half.
    expect(detail.calls.map((entry) => entry.modelId)).toContain(modelId);
  });

  it("reports a mismatch when the recorded cost does not match today's price", async () => {
    const config = loadProviderConfig();
    const candidate = config.roles.generator?.chain[0];
    if (candidate === undefined) throw new Error("admin test: the generator chain is empty");
    const [provider, modelId] = parseCandidateKey(candidate);
    const model = config.vendors[provider]?.models[modelId];
    if (model === undefined)
      throw new Error("admin test: the generator candidate does not resolve");
    const expected = computeCost(modelId, model.priceMicroUsdPerMTok, 10, 7, 100).costMicroUsd;
    // The trace recorded a cost one micro-USD above what the configured price yields —
    // the shape a price edit leaves on an older trace. The recorded figure must stay the
    // figure shown, and the mirror half must say it no longer matches.
    const store = await seededStore([
      {
        generatorModelId: modelId,
        generatorTokensIn: 10,
        generatorTokensOut: 7,
        generatorCostMicroUsd: expected + 1,
      },
    ]);
    const { headers, traceId, instance } = await detailOf(store);
    const res = await instance.request(`/v1/admin/traces/${traceId}`, { headers }, adminEnv());
    const detail = (await res.json()) as { calls: AdminTraceCall[] };
    const call = detail.calls.find((entry) => entry.stage === "generator")!;
    expect(call.costMicroUsd).toBe(expected + 1);
    expect(call.modelConfig.status).toBe("mismatch");
    expect(call.modelConfig.matches.every((match) => match.consistent === false)).toBe(true);
    expect(call.modelConfig.matches[0]?.computedCostMicroUsd).toBe(expected);
  });

  it("reports an unresolved model explicitly instead of omitting the call", async () => {
    const store = await seededStore();
    const { headers, traceId, instance } = await detailOf(store);
    const res = await instance.request(`/v1/admin/traces/${traceId}`, { headers }, adminEnv());
    const detail = (await res.json()) as { calls: AdminTraceCall[] };
    const call = detail.calls.find((entry) => entry.stage === "generator")!;
    expect(call.modelId).toBe("generator-stub");
    expect(call.modelConfig).toEqual({ status: "unresolved", matches: [] });
  });

  it("refuses the detail on a drifted mirror, logs structurally, and keeps the raw download", async () => {
    const store = await seededStore();
    // A row left behind by a config edit that never went through the sync: the mirror
    // still names a model the config does not carry. Serving the detail would present a
    // retired price as current.
    await runStoreEffect(
      store.syncModelConfigs([
        ...mirrorEntries(),
        {
          role: "generator",
          provider: "retired-provider",
          modelId: "retired-model",
          config: { priceMicroUsdPerMTok: { in: 1, out: 1 } },
        },
      ]),
    );
    const { headers, traceId, instance } = await detailOf(store);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const res = await instance.request(`/v1/admin/traces/${traceId}`, { headers }, adminEnv());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "model_config_drift" });
      expect(res.headers.get("cache-control")).toBe("no-store");
      const drift = lines
        .filter((line) => line.includes("admin.model_config_drift"))
        .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
      expect(drift).toMatchObject({
        level: "error",
        outcome: "drift",
        missing: 0,
        unexpected: 1,
        changed: 0,
        inactive: 0,
      });
      // The raw download carries no mirror-derived data, so the escape hatch still works.
      const raw = await instance.request(
        `/v1/admin/traces/${traceId}/raw`,
        { headers },
        adminEnv(),
      );
      expect(raw.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("admin surface: the public product stays untouched", () => {
  it("keeps the anonymous Bearer session out of the admin surface and vice versa", async () => {
    const store = await seededStore();
    const session = await runStoreEffect<{ token: string }>(store.createSession());
    // A public Bearer token opens no admin read…
    const admin = await api().request(
      "/v1/admin/traces",
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
