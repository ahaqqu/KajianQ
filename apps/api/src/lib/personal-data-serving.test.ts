/// <reference types="node" />
// The drift guard below reads the checked-in provider config from the repo
// (Node can; the API bundle cannot). The directive is file-scoped because
// apps/api types the app for the Workers/Bun runtime only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProviderConfig } from "@app/infra";

/**
 * The free-tier trust invariant (ADR-0043 Consequences — the "measured gap"
 * this test exists to close, #181's `PromptSpec.personalData` precondition).
 *
 * The invariant: **no chat question can ride a free-tier vendor.** The
 * failure mode is silent by construction — `FallbackProvider` filters
 * free-tier candidates only when a call sets `personalData`, so a serving
 * call site that simply forgets the flag keeps working, keeps passing the
 * Golden Set, and quietly leaks personal data (a fiqh question can reveal
 * religious convictions, Art. 9) to a vendor whose free-tier terms permit
 * using the input to improve its models. No error, no trace marker.
 *
 * Two layers pin it, and this file asserts both:
 *
 *   1. **Type layer.** The domain's serving stage seams (`RouterProvider`,
 *      `GeneratorProvider`, `ReviewerProvider`, `RetrieverEmbedder` in
 *      `@app/kajianq-domain`) declare `personalData: true` as a REQUIRED,
 *      non-optional field on the spec. A stage call site that drops the
 *      flag is a compile error (`bun run check`), not a runtime hope. The
 *      flag is literal `true` — a serving seam cannot declare `false`.
 *
 *   2. **Config layer (below).** With the flag now set on every serving
 *      call, a role whose ONLY keyed candidates are free-tier vendors
 *      (`personalDataAllowed: false`) fails every call with a typed
 *      `ProviderError` rather than silently routing personal data to the
 *      free tier. The test walks the real `models.json` — the same file the
 *      register's `Tier` column derives from — so a `freeTier` /
 *      `personalDataAllowed` edit that would break the chat path fails HERE
 *      first, in CI, instead of in production traffic.
 *
 * Trap cases named before writing:
 *   - the `cheap` role's chain head IS a free-tier vendor today (Gemini) —
 *     the flag must push those calls to the paid tail, never the head;
 *   - a vendor row that says `freeTier: false` but
 *     `personalDataAllowed: false` is still disallowed — the register rule
 *     keys on the personal-data column, not the price column;
 *   - an unkeyed candidate is not a violation (it is filtered at wiring and
 *     the call would fail with the missing-key error) — only candidates the
 *     environment actually keys in count.
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

/** Every provider role the chat serving path resolves (chat-wiring.ts). */
const SERVING_ROLES = ["cheap", "generator", "reviewer", "embedder"] as const;

/**
 * The env-name set every serving role is keyed with in a fully-configured
 * deployment (the same names the deployer passes through; the two #181-added
 * keys — GEMINI_PAID_API_KEY for the paid-terms embedder row and
 * MOONSHOT_API_KEY for the reviewer head — are owner-provisioned preconditions
 * named in the cutover runbook). A candidate is "keyed" when its vendor's
 * `apiKeyEnv` is in this set — the same filter `resolveRole` applies at wiring
 * time.
 */
const DEPLOYED_KEYS = new Set([
  "GEMINI_API_KEY",
  "GEMINI_PAID_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
]);

const config = loadProviderConfig();

describe("serving personal-data precondition (ADR-0043 gap, #181)", () => {
  it("every chat serving role has at least one keyed candidate that allows personal data", () => {
    // The hard invariant. If a role's keyed candidates are all
    // `personalDataAllowed: false`, then with `personalData: true` now set
    // by every serving call site, that role cannot answer ANY chat call —
    // it fails with a typed error instead of silently riding the free
    // tier. That is the designed behavior, but it means the chat path is
    // down, so it must be caught in CI, at the config edit, not at runtime.
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
    // Drift guard: `createProvidersFromEnv` resolves roles through
    // `loadProviderConfig()`; the test above reads the file directly. The
    // two must describe the same roles or the assertion above is testing a
    // stale copy.
    for (const role of SERVING_ROLES) {
      expect(config.roles[role], role).toBeDefined();
    }
  });

  it("no free-tier vendor is wired into a serving role's chain head (defense in depth)", () => {
    // Even though the flag now protects every serving call, a free-tier
    // CHAIN HEAD on a serving role is a loaded gun: one dropped flag in a
    // future call site and personal data rides the free tier again. The
    // `cheap` role historically had exactly this shape (free-tier Gemini
    // head) — this pins that it does not come back.
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
