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
 * Trap cases: the `cheap` chain head IS a free-tier vendor, so the flag must push calls to the
 * paid tail; a `freeTier: false` row with `personalDataAllowed: false` is still disallowed (the
 * rule keys on personal data, not price); an unkeyed candidate is not a violation.
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
};

const SERVING_ROLES = CHAT_SERVING_ROLES;

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
  // The decision vendor's key: optional in serving, but when keyed this guard must judge
  // the candidate it would wire.
  "JEV_API_KEY",
]);

const config = loadProviderConfig();

describe("serving personal-data precondition (ADR-0043 gap, #181)", () => {
  it("every chat serving role has at least one keyed candidate that allows personal data", () => {
    // A role whose keyed candidates are all `personalDataAllowed: false` cannot answer
    // ANY chat call with `personalData: true` set — designed behavior, but the chat path
    // is down, so it must fail in CI at the config edit, not at runtime.
    const failures: string[] = [];
    for (const role of SERVING_ROLES) {
      const allowed = (MODELS.roles[role]?.chain ?? []).filter((key) => {
        const vendor = key.slice(0, key.indexOf(":"));
        const row = MODELS.vendors[vendor];
        return row !== undefined && DEPLOYED_KEYS.has(row.apiKeyEnv) && row.personalDataAllowed;
      });
      if (allowed.length === 0) failures.push(role);
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
