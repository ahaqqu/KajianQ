/// <reference types="node" />
// Node types, file-scoped: the drift guard below reads the checked-in provider
// config from the repo, which the API bundle cannot do.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { loadProviderConfig } from "@app/infra";
import { CHAT_SERVING_ROLES } from "./chat-wiring";

/**
 * The free-tier trust invariant: **no chat question can ride a free-tier vendor.**
 * `FallbackProvider` filters free-tier candidates only when a call sets `personalData`,
 * so a call site that forgets the flag keeps working and quietly leaks personal data
 * (Art. 9) to a free-tier vendor that may train on the input.
 *
 * Two layers pin it, and this file asserts both:
 *
 *   1. **Type layer.** The serving stage seams (`RouterProvider`, `GeneratorProvider`,
 *      `ReviewerProvider`, `RetrieverEmbedder`) declare `personalData: true` as a
 *      REQUIRED, non-optional field, so dropping it is a compile error (never `false`).
 *
 *   2. **Config layer (below).** A role whose ONLY keyed candidates are free-tier vendors
 *      (`personalDataAllowed: false`) fails every call with a typed `ProviderError`,
 *      never a silent route to the free tier; the test walks the real `models.json`, so
 *      such an edit fails HERE. The `decision` role is in scope (it sends personal data).
 *
 * Trap cases: the `cheap` chain carries a keyed free-tier tail, so the flag must keep
 * personal-data calls on the paid head; a `freeTier: false` row with `personalDataAllowed:
 * false` is still disallowed (the rule keys on personal data, not price); an unkeyed
 * candidate is not a violation. Every profile the config declares is walked the same
 * way, plus the identity `default` profile, so no profile can reintroduce a free-tier
 * head or drop a serving role's paid candidate.
 */

type VendorRow = { freeTier: boolean; personalDataAllowed: boolean };

const MODELS = JSON.parse(
  readFileSync(
    new URL("../../../../packages/infra/src/providers/models.json", import.meta.url).pathname,
    "utf8",
  ),
) as {
  vendors: Record<string, VendorRow & { apiKeyEnv: string }>;
  roles: Record<string, { chain: string[] }>;
  profiles?: Record<string, Record<string, string[]>>;
};

const SERVING_ROLES = CHAT_SERVING_ROLES;

/** Every profile the guard must judge: the identity profile plus each declared override set. */
const PROFILES = [...new Set(["default", ...Object.keys(MODELS.profiles ?? {})])];

/**
 * The env-name set every serving role is keyed with in a fully-configured deployment:
 * `GEMINI_PAID_API_KEY` (the paid-terms embedder head) is an owner-provisioned
 * precondition without which the embedder stage fails with a typed error.
 */
const DEPLOYED_KEYS = new Set([
  "GEMINI_API_KEY",
  "GEMINI_PAID_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  // The switchable chat vendor's key: optional in the default profile, but a profile that
  // routes a serving role to this row must still carry a paid, personal-data-allowed
  // candidate when the key is bound (ADR-0059).
  "OLLAMA_API_KEY",
  // The decision vendor's key: optional in serving, but when keyed this guard must judge
  // the candidate it would wire.
  "JEV_API_KEY",
]);

const config = loadProviderConfig();

/** A role's chain as the file declares it under a profile: the override when there is one. */
function fileChain(profile: string, role: string): string[] {
  return MODELS.profiles?.[profile]?.[role] ?? MODELS.roles[role]?.chain ?? [];
}

/** The keyed, personal-data-allowed candidates in a chain. */
function allowedCandidates(chain: string[]): string[] {
  return chain.filter((key) => {
    const vendor = key.slice(0, key.indexOf(":"));
    const row = MODELS.vendors[vendor];
    return row !== undefined && DEPLOYED_KEYS.has(row.apiKeyEnv) && row.personalDataAllowed;
  });
}

describe("serving personal-data precondition (ADR-0043 gap, #181)", () => {
  it("every chat serving role has at least one keyed candidate that allows personal data", () => {
    // A role whose keyed candidates are all `personalDataAllowed: false` cannot answer
    // ANY chat call with `personalData: true` set — designed behavior, but the chat path
    // is down, so it must fail in CI at the config edit, not at runtime.
    const failures: string[] = [];
    for (const role of SERVING_ROLES) {
      if (allowedCandidates(MODELS.roles[role]?.chain ?? []).length === 0) failures.push(role);
    }
    expect(failures).toEqual([]);
  });

  it("the checked-in config the wiring parses agrees with the models.json file", () => {
    // `createProvidersFromEnv` resolves roles through `loadProviderConfig()` while the
    // test above reads the file directly; both must describe the same roles.
    for (const role of SERVING_ROLES) {
      expect(config.roles[role], role).toBeDefined();
    }
  });

  it("no free-tier vendor is wired into a serving role's chain head (defense in depth)", () => {
    // Defense in depth: a free-tier CHAIN HEAD on a serving role is one dropped flag
    // away from personal data riding the free tier.
    for (const role of SERVING_ROLES) {
      const chain = MODELS.roles[role]?.chain ?? [];
      const head = chain[0];
      if (head === undefined) continue;
      const vendor = head.slice(0, head.indexOf(":"));
      const row = MODELS.vendors[vendor];
      expect(
        { role, freeTier: row?.freeTier ?? false, personalDataAllowed: row?.personalDataAllowed },
        role,
      ).not.toEqual({ role, freeTier: true, personalDataAllowed: false });
    }
  });
});

describe("serving personal-data precondition — every declared profile (ADR-0059)", () => {
  it("declares the switchable profile this change ships", () => {
    expect(Object.keys(MODELS.profiles ?? {})).toContain("ollama");
  });

  it("registers the new vendor row as paid, personal-data-allowed and deployment-keyed", () => {
    const row = MODELS.vendors["ollama-cloud"];
    expect(row, "ollama-cloud is missing from models.json").toBeDefined();
    expect(row!.freeTier).toBe(false);
    expect(row!.personalDataAllowed).toBe(true);
    // A row this guard judges must be one a configured deployment can key — otherwise
    // the walk below would pass by filtering the candidate out, not by clearing it.
    expect(DEPLOYED_KEYS.has(row!.apiKeyEnv)).toBe(true);
  });

  it("keeps every chat serving role on a keyed personal-data-allowed candidate under every profile", () => {
    // `ProfilesSchema` accepts any name, so the walk is generic rather than pinned to
    // the profiles that exist today: a new profile that re-heads a serving role on a
    // free-tier or unkeyed vendor must fail this guard, and the failure names the
    // profile and role.
    const failures: string[] = [];
    for (const profile of PROFILES) {
      const parsed = loadProviderConfig(profile);
      for (const role of SERVING_ROLES) {
        const chain = parsed.roles[role]?.chain ?? [];
        if (allowedCandidates(chain).length === 0) {
          failures.push(`profile "${profile}" role "${role}" (chain: ${chain.join(", ")})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every serving role's chain head off a free-tier vendor under every profile", () => {
    // Defense in depth: a free-tier CHAIN HEAD on a serving role is one dropped flag
    // away from personal data riding the free tier.
    const failures: string[] = [];
    for (const profile of PROFILES) {
      const parsed = loadProviderConfig(profile);
      for (const role of SERVING_ROLES) {
        const head = parsed.roles[role]?.chain[0];
        if (head === undefined) continue;
        const row = MODELS.vendors[head.slice(0, head.indexOf(":"))];
        if (row?.freeTier === true && row.personalDataAllowed === false) {
          failures.push(`profile "${profile}" role "${role}" head ${head}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("overrides exactly the four serving roles and keeps the cheap free-tier tail", () => {
    // The profile is a chain-set switch, not a vendor-only rewrite: the roles it does
    // not name must stay exactly the base chains, and the free-tier tail must stay in
    // the cheap chain so the personal-data filter's trap case remains wired.
    expect(Object.keys(MODELS.profiles?.["ollama"] ?? {}).sort()).toEqual([
      "cheap",
      "generator",
      "reviewer",
      "reviewer-live",
    ]);
    const parsed = loadProviderConfig("ollama");
    for (const role of SERVING_ROLES) {
      if (role === "cheap" || role === "generator" || role === "reviewer") continue;
      expect(parsed.roles[role]?.chain, role).toEqual(MODELS.roles[role]?.chain);
    }
    const cheap = parsed.roles.cheap?.chain ?? [];
    const headVendor = cheap[0]!.slice(0, cheap[0]!.indexOf(":"));
    const tailVendor = cheap.at(-1)!.slice(0, cheap.at(-1)!.indexOf(":"));
    expect(MODELS.vendors[headVendor]?.personalDataAllowed).toBe(true);
    expect(MODELS.vendors[tailVendor]?.freeTier).toBe(true);
    expect(MODELS.vendors[tailVendor]?.personalDataAllowed).toBe(false);
  });

  it("the wiring parses every profile into the same chains the file declares", () => {
    // `loadProviderConfig(profile)` is what `createProvidersFromEnv` resolves against;
    // the file walk above and the parsed config must not describe different chains.
    for (const profile of PROFILES) {
      const parsed = loadProviderConfig(profile);
      for (const role of SERVING_ROLES) {
        expect(parsed.roles[role]?.chain, `profile "${profile}" role "${role}"`).toEqual(
          fileChain(profile, role),
        );
      }
    }
  });
});
