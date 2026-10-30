import { describe, expect, it, vi } from "vite-plus/test";
import { CALLER_PRIORITY_K, CHAIN_EVIDENCE_TRACE_LIMIT } from "@app/contracts";
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import {
  authGuard,
  buildChatWiring,
  buildStoreWiring,
  ChatConfigError,
  createProvidersFromEnv,
  parseCallerPriorityK,
  parseChainEvidenceChainCap,
  parseLabelLookupCap,
  parseNeighbourCap,
  parseNeighbourRadius,
  parseScopeExpansionCap,
  sseFrame,
  storeBridge,
  wiringOr503,
} from "../lib/chat-wiring";

async function awaitImportConfig() {
  const { loadProviderConfig } = await import("@app/infra");
  return { loadProviderConfig };
}

// The database client lives behind the RagStore adapter (ADR-0008), so
// these route tests never reach one: constructing or querying the pool is
// the failure this mock makes loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("chat-wiring test: the database must not be reached");
    }
  },
}));

describe("sseFrame — the wire format", () => {
  it("emits one data line per line of a multi-line payload", () => {
    // A raw newline inside a single `data:` payload creates a blank line,
    // which terminates the frame — a spec-following client (the eval harness)
    // then drops the rest of the answer.
    const frame = sseFrame("delta", "line one\n\nline two");
    expect(frame).toBe("event: delta\ndata: line one\ndata: \ndata: line two\n\n");
    expect(frame.split("\n\n").length).toBe(2);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("round-trips a multi-line payload through the eval client's parser semantics", () => {
    const frame = sseFrame("delta", "a\nb");
    const body = frame.slice(0, frame.length - 2);
    const dataLines = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    expect(dataLines.join("\n")).toBe("a\nb");
  });

  it("preserves trailing whitespace in a single-line payload", () => {
    expect(sseFrame("delta", "word ")).toBe("event: delta\ndata: word \n\n");
  });

  it("emits a data line for an empty payload", () => {
    expect(sseFrame("done", "{}")).toBe("event: done\ndata: {}\n\n");
  });
});

describe("buildChatWiring — the reviewer is mandatory on the chat path", () => {
  it("refuses to wire a chat path with no keyed reviewer candidate", () => {
    // A reviewer-less chat path would silently serve unreviewed answers; the
    // wiring fails closed instead (the route maps it to 503).
    expect(() => buildChatWiring({ DATABASE_URL: "postgres://x" })).toThrow(
      /reviewer role has no keyed candidate/,
    );
  });
});

describe("parseScopeExpansionCap — ADR-0045's budget knob", () => {
  it("treats absent and empty as 'use the domain default'", () => {
    expect(parseScopeExpansionCap(undefined)).toBeUndefined();
    expect(parseScopeExpansionCap("")).toBeUndefined();
    expect(parseScopeExpansionCap("   ")).toBeUndefined();
  });

  it("parses a non-negative integer, including the 0 that disables expansion", () => {
    expect(parseScopeExpansionCap("12")).toBe(12);
    expect(parseScopeExpansionCap("0")).toBe(0);
  });

  it("fails closed on a malformed value instead of silently using the default", () => {
    for (const bad of ["-1", "abc", "1.5", "12x"]) {
      expect(() => parseScopeExpansionCap(bad)).toThrow(ChatConfigError);
    }
  });

  it("wires the configured cap into the pipeline and states it absent when unset", () => {
    const keyed = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };
    expect(
      buildChatWiring({ ...keyed, SCOPE_EXPANSION_CAP: "7" }).pipeline.retrieval,
    ).toMatchObject({
      scopeExpansionCap: 7,
    });
    // Unset is a stated `undefined`, not a dropped key: the retriever's `??` default is
    // what applies, so an unconfigured box is unchanged.
    expect(buildChatWiring(keyed).pipeline.retrieval.scopeExpansionCap).toBeUndefined();
  });

  it("reports a malformed cap as a typed config failure", () => {
    expect(() =>
      buildChatWiring({
        DATABASE_URL: "postgres://x",
        DEEPSEEK_API_KEY: "k",
        SCOPE_EXPANSION_CAP: "nope",
      }),
    ).toThrow(/SCOPE_EXPANSION_CAP/);
  });

  it("parses ADR-0049's neighbourhood knobs with the scope cap's rule", () => {
    // The same contract as SCOPE_EXPANSION_CAP: absent/empty = the domain
    // default, `0` is a real value (it disables), anything malformed is a typed
    // config failure naming its own variable — never a silent default.
    expect(parseNeighbourRadius(undefined)).toBeUndefined();
    expect(parseNeighbourRadius("  ")).toBeUndefined();
    expect(parseNeighbourRadius("2")).toBe(2);
    expect(parseNeighbourRadius("0")).toBe(0);
    expect(parseNeighbourCap("12")).toBe(12);
    expect(parseNeighbourCap("0")).toBe(0);
    for (const bad of ["-1", "abc", "1.5", "12x"]) {
      expect(() => parseNeighbourRadius(bad)).toThrow(/NEIGHBOUR_EXPANSION_RADIUS/);
      expect(() => parseNeighbourCap(bad)).toThrow(/NEIGHBOUR_EXPANSION_CAP/);
    }
  });

  it("wires the configured neighbourhood window into the pipeline and states it absent when unset", () => {
    const keyed = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };
    expect(
      buildChatWiring({
        ...keyed,
        NEIGHBOUR_EXPANSION_RADIUS: "2",
        NEIGHBOUR_EXPANSION_CAP: "6",
      }).pipeline.retrieval,
    ).toMatchObject({ neighbourRadius: 2, neighbourCap: 6 });
    // Unset means the retriever's own `?? DEFAULT_…` applies; the deps still state the
    // absent value, so the knob reaches the retriever and cannot vanish by omission.
    const retrieval = buildChatWiring(keyed).pipeline.retrieval;
    expect(retrieval.neighbourRadius).toBeUndefined();
    expect(retrieval.neighbourCap).toBeUndefined();
  });

  it("parses ADR-0058's label-lookup cap with the same rule and wires it", () => {
    expect(parseLabelLookupCap(undefined)).toBeUndefined();
    expect(parseLabelLookupCap("  ")).toBeUndefined();
    expect(parseLabelLookupCap("8")).toBe(8);
    // `0` is a real value: it turns the arm off without making the query fail.
    expect(parseLabelLookupCap("0")).toBe(0);
    for (const bad of ["-1", "abc", "1.5", "12x"]) {
      expect(() => parseLabelLookupCap(bad)).toThrow(/LABEL_LOOKUP_CAP/);
    }
    const keyed = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };
    expect(buildChatWiring({ ...keyed, LABEL_LOOKUP_CAP: "5" }).pipeline.retrieval).toMatchObject({
      labelLookupCap: 5,
    });
    expect(buildChatWiring(keyed).pipeline.retrieval.labelLookupCap).toBeUndefined();
  });

  it("parses ADR-0062's caller-priority bound with the same rule, ceiling included, and wires it", () => {
    expect(parseCallerPriorityK(undefined)).toBeUndefined();
    expect(parseCallerPriorityK("  ")).toBeUndefined();
    expect(parseCallerPriorityK("1")).toBe(1);
    // `0` is a real value: it turns the guarantee off without making the query fail.
    expect(parseCallerPriorityK("0")).toBe(0);
    expect(parseCallerPriorityK(String(CALLER_PRIORITY_K))).toBe(CALLER_PRIORITY_K);
    for (const bad of ["-1", "abc", "1.5", "12x"]) {
      expect(() => parseCallerPriorityK(bad)).toThrow(/CALLER_PRIORITY_K/);
    }
    // The contract's `caller_priority` record refuses more ids than its ceiling, so a
    // value above it is a typed config failure here — never an answer whose trace
    // cannot be parsed back.
    expect(() => parseCallerPriorityK(String(CALLER_PRIORITY_K + 1))).toThrow(ChatConfigError);
    expect(() => parseCallerPriorityK(String(CALLER_PRIORITY_K + 1))).toThrow(/CALLER_PRIORITY_K/);
    const keyed = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };
    expect(buildChatWiring({ ...keyed, CALLER_PRIORITY_K: "2" }).pipeline.retrieval).toMatchObject({
      callerPriorityK: 2,
    });
    expect(buildChatWiring(keyed).pipeline.retrieval.callerPriorityK).toBeUndefined();
  });

  it("parses the per-chain row budget with a refused 0, the trace ceiling, and wires it", () => {
    expect(parseChainEvidenceChainCap(undefined)).toBeUndefined();
    expect(parseChainEvidenceChainCap("  ")).toBeUndefined();
    expect(parseChainEvidenceChainCap("1")).toBe(1);
    expect(parseChainEvidenceChainCap(String(CHAIN_EVIDENCE_TRACE_LIMIT))).toBe(
      CHAIN_EVIDENCE_TRACE_LIMIT,
    );
    // `0` has no disable meaning here: the read would consult a child, carry no row
    // and record nothing, so the citation would fall back to the flattened grade. It
    // is a typed config failure like the above-limit value, not a second spelling of
    // "off": CHAIN_EVIDENCE_CHILD_CAP=0 is the read's disable.
    expect(() => parseChainEvidenceChainCap("0")).toThrow(ChatConfigError);
    expect(() => parseChainEvidenceChainCap("0")).toThrow(
      /CHAIN_EVIDENCE_CHAIN_CAP must be at least 1/,
    );
    expect(() => parseChainEvidenceChainCap(String(CHAIN_EVIDENCE_TRACE_LIMIT + 1))).toThrow(
      /CHAIN_EVIDENCE_CHAIN_CAP must not exceed/,
    );
    for (const bad of ["-1", "abc", "1.5", "12x"]) {
      expect(() => parseChainEvidenceChainCap(bad)).toThrow(/CHAIN_EVIDENCE_CHAIN_CAP/);
    }
    const keyed = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };
    expect(
      buildChatWiring({ ...keyed, CHAIN_EVIDENCE_CHAIN_CAP: "2" }).pipeline.retrieval,
    ).toMatchObject({ chainEvidenceChainCap: 2 });
    expect(buildChatWiring(keyed).pipeline.retrieval.chainEvidenceChainCap).toBeUndefined();
    expect(() => buildChatWiring({ ...keyed, CHAIN_EVIDENCE_CHAIN_CAP: "0" })).toThrow(
      ChatConfigError,
    );
  });
});

describe("buildStoreWiring — auth's store-only entry (A4)", () => {
  it("does not resolve or require any provider role", () => {
    // With an env that has no keys at all, the store-only entry's ONLY
    // possible complaint is the missing database binding — the reviewer check
    // that fails `buildChatWiring` on the same env must not exist on this path.
    expect(() => buildStoreWiring({})).toThrow(/DATABASE_URL is not bound/);
    expect(() => buildStoreWiring({})).not.toThrow(/reviewer/);
    expect(() => buildChatWiring({})).toThrow(/reviewer role has no keyed candidate/);
  });

  it("still fails closed when the store is not configured", () => {
    expect(() => buildStoreWiring({})).toThrow(ChatConfigError);
  });
});

describe("wiringOr503 — the shared 503 posture (B1)", () => {
  /** A Logger that records warn calls and discards the rest. */
  function recordingLogger(warnings: { msg: string; fields?: Record<string, unknown> }[]) {
    const logger = {
      child: () => logger,
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => {
        warnings.push(fields === undefined ? { msg } : { msg, fields });
      },
      error: () => {},
    };
    return logger;
  }

  it("maps a typed config failure to the route's error code at 503", () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const result = wiringOr503(
      () => {
        throw new ChatConfigError("no binding", "DATABASE_URL");
      },
      recordingLogger(warnings),
      "auth_not_configured",
    );
    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(503);
    }
    expect(warnings[0]?.fields?.["errorCode"]).toBe("auth_not_configured");
  });

  it("rethrows a non-config failure instead of masking it as not-configured", () => {
    expect(() =>
      wiringOr503(
        () => {
          throw new Error("adapter bug");
        },
        recordingLogger([]),
        "chat_not_configured",
      ),
    ).toThrow("adapter bug");
  });
});

describe("createProvidersFromEnv", () => {
  it("resolves every role from an empty env (calls fail, wiring never branches)", () => {
    const providers = createProvidersFromEnv({});
    expect(providers.missingKeys.length).toBeGreaterThan(0);
    // No keyed candidate → reviewer is null (skipped, not failed).
    expect(providers.reviewer).toBeNull();
  });

  it("reports the missing env names for ops visibility", async () => {
    const providers = createProvidersFromEnv({});
    // The chat roles (cheap/generator/reviewer/embedder) resolve their env
    // names from the config data (ADR-0022), never hard-coded here.
    const { loadProviderConfig } = await awaitImportConfig();
    const vendors: Record<string, { apiKeyEnv: string }> = loadProviderConfig().vendors;
    for (const envName of new Set(Object.values(vendors).map((v) => v.apiKeyEnv))) {
      const usedByChatRoles = ["cheap", "generator", "reviewer", "embedder"].some((role) =>
        loadProviderConfig().roles[role]?.chain.some((k) => {
          const parts = k.split(":");
          const vendor = parts[0] ?? "";
          return vendor !== "" && vendors[vendor]?.apiKeyEnv === envName;
        }),
      );
      if (usedByChatRoles) {
        expect(providers.missingKeys).toContain(envName);
      }
    }
  });

  it("wires the reviewer pre-gate only when the decision role's key is bound (#168)", async () => {
    // The always-on-where-the-key-is-bound posture (ADR-0042) has no enable
    // flag to assert: the key IS the flag. The env name is read from the
    // config data (ADR-0022), never hard-coded.
    const { loadProviderConfig } = await awaitImportConfig();
    const config = loadProviderConfig();
    const [vendorName = ""] = (config.roles.decision?.chain[0] ?? "").split(":");
    const decisionKeyEnv = config.vendors[vendorName]?.apiKeyEnv;
    expect(decisionKeyEnv).toBeDefined();

    expect(createProvidersFromEnv({}).decider).toBeNull();
    const keyed = createProvidersFromEnv({ [decisionKeyEnv as string]: "test-key" });
    expect(keyed.decider).not.toBeNull();
    expect(keyed.decider?.modelId).toBe(config.roles.decision?.chain[0]?.split(":")[1]);
    // The serving chain is resolved with `personalData: true` (ADR-0043); the
    // shipped decision vendor allows personal data, so nothing is excluded.
    expect(keyed.ineligibleKeys).toEqual([]);
    // An absent key is reported for ops visibility but is not a config
    // failure: the reviewer's existing path is the fail-open fallback.
    expect(createProvidersFromEnv({}).missingKeys).toContain(decisionKeyEnv);
  });
});

describe("storeBridge", () => {
  it("runs an Effect-signatured store call to a promise", async () => {
    const store = createMemoryRagStore();
    const run = storeBridge(store);
    const result = await run(store.resolveUserId("anything"));
    expect(result).toBeNull();
  });
});

describe("authGuard", () => {
  function fakeContext(header: string | undefined): unknown {
    let authed: unknown;
    return {
      req: { header: (name: string) => (name === "authorization" ? header : undefined) },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
      set: (_key: string, value: unknown) => {
        authed = value;
      },
      getAuthed: () => authed,
    };
  }

  it("401s a missing Authorization header", async () => {
    const store = createMemoryRagStore();
    const c = fakeContext(undefined);
    const res = await authGuard(c as never, store);
    expect(res?.status).toBe(401);
  });

  it("401s an unknown token", async () => {
    const store = createMemoryRagStore();
    const c = fakeContext("Bearer nope");
    const res = await authGuard(c as never, store);
    expect(res?.status).toBe(401);
  });

  it("stashes the Authed variable for a known token", async () => {
    const store = createMemoryRagStore();
    // The typed bridge infers A from the store call — no explicit type arg.
    const session = await runStoreEffect(store.createSession());
    const c = fakeContext(`Bearer ${session.token}`);
    const res = await authGuard(c as never, store);
    expect(res).toBeUndefined();
  });
});
