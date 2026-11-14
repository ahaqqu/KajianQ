import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import {
  loadProviderConfig,
  parseCandidateKey,
  parseProviderConfig,
  ProviderConfigError,
  resolveChain,
} from "./provider-config";
import { testVendor } from "./test-fixtures";

describe("provider config", () => {
  it("loads and validates the checked-in models.json", () => {
    const config = loadProviderConfig();
    // Role defaults from spec §3.4 exist as chains.
    expect(config.roles.generator?.chain.length).toBeGreaterThan(0);
    expect(config.roles.cheap?.chain.length).toBeGreaterThan(1);
    expect(config.roles.embedder?.chain.length).toBeGreaterThan(0);
    // Every chain candidate resolves to a real vendor+model.
    for (const { chain } of Object.values(config.roles)) {
      for (const key of chain) {
        const [vendor, modelId] = parseCandidateKey(key);
        const vendorConfig = config.vendors[vendor];
        expect(vendorConfig).toBeDefined();
        expect(vendorConfig?.models[modelId]).toBeDefined();
      }
    }
  });

  it("serves the decision model the multilingual gate measured (ADR-0042 adoption, #168)", () => {
    const config = loadProviderConfig();
    const serving = resolveChain(config, "decision");
    const bench = resolveChain(config, "decision-candidates");
    // Serving adopts exactly what the gate scored: the pinned candidate the
    // committed bench report covers. A re-bench can add challengers to the
    // bench-only role without silently changing what serves.
    expect(serving).toHaveLength(1);
    // The serving candidate must speak the decisions wire's typed-questions
    // protocol (ADR-0042's adoption over the aggregator's decisions transport)
    // and price inputs.
    expect(serving[0]?.vendorConfig.protocol).toBe("decisions");
    expect(serving[0]?.modelConfig.capabilities).toContain("decide");
    expect(serving[0]?.modelConfig.priceMicroUsdPerMTok.in).toBeGreaterThan(0);
    // Serving is adopted FROM the benched set — never a candidate the gate did
    // not measure. (The bench role itself stays bench-only: serving resolves
    // the `decision` role, proven at the wiring seam.)
    expect(
      bench.some(
        (candidate) =>
          candidate.vendor === serving[0]?.vendor && candidate.modelId === serving[0]?.modelId,
      ),
    ).toBe(true);
  });

  it("ships a bench role the decider can actually construct — every candidate decides", () => {
    // The ADR-0042 bench resolves every keyed candidate through the decider,
    // whose constructor refuses a model without the `decide` capability — a
    // bench candidate without it would crash the owner's hand-run bench before
    // any candidate runs. The walk keeps the whole bench chain constructible.
    const config = loadProviderConfig();
    for (const candidate of resolveChain(config, "decision-candidates")) {
      expect(
        candidate.modelConfig.capabilities,
        `${candidate.vendor}:${candidate.modelId} must carry "decide"`,
      ).toContain("decide");
    }
  });

  it("carries the decision role's bench-adoption state (ADR-0042's committed posture)", () => {
    const config = loadProviderConfig();
    // The committed re-bench report flipped the marker; a re-bench that finds a
    // better candidate flips it again. The boot posture report reads it.
    expect(config.roles.decision?.benchAdoption).toBe("committed");
  });

  it("rejects an unknown bench-adoption value", () => {
    expect(() =>
      parseProviderConfig({
        vendors: { test: testVendor },
        roles: { cheap: { chain: ["test:m-chat"], benchAdoption: "nope" } },
      }),
    ).toThrow();
  });

  it("rejects a malformed or dangling config", () => {
    expect(() =>
      parseProviderConfig({
        vendors: { test: testVendor },
        roles: { cheap: { chain: ["test:no-such-model"] } },
      }),
    ).toThrow(/unknown model "no-such-model"/);
    expect(() =>
      parseProviderConfig({
        vendors: { test: testVendor },
        roles: { cheap: { chain: [] } },
      }),
    ).toThrow(/empty chain/);
    expect(() => parseCandidateKey("no-colon")).toThrow(/malformed candidate key/);
    expect(() => parseCandidateKey("vendoronly:")).toThrow(/malformed candidate key/);
  });

  it("validates a profile's override chains and roles at load time", () => {
    // A profile is data like the base chains: a dangling candidate or an override
    // of a role that does not exist is a config fault, whether or not the profile
    // is the one this deployment selects.
    const base = {
      vendors: { test: testVendor },
      roles: { cheap: { chain: ["test:m-chat"] } },
    };
    expect(() =>
      parseProviderConfig({ ...base, profiles: { alt: { cheap: ["test:missing"] } } }),
    ).toThrow(/profile "alt" role "cheap" references unknown model "missing"/);
    expect(() => parseProviderConfig({ ...base, profiles: { alt: { cheap: [] } } })).toThrow(
      /profile "alt" role "cheap" has an empty chain/,
    );
    expect(() =>
      parseProviderConfig({ ...base, profiles: { alt: { unknownRole: ["test:m-chat"] } } }),
    ).toThrow(/profile "alt" overrides unknown role "unknownRole"/);
    // A valid profile parses and stays separable from the base roles.
    const parsed = parseProviderConfig({
      ...base,
      profiles: { alt: { cheap: ["test:m-embed"] } },
    });
    expect(parsed.roles.cheap?.chain).toEqual(["test:m-chat"]);
    expect(parsed.profiles?.alt?.cheap).toEqual(["test:m-embed"]);
  });

  it("rejects a non-empty `default` profile instead of silently ignoring it", () => {
    // `default` is the base `roles` block, which the loader returns before it
    // consults `profiles`: an entry there would validate and then never apply,
    // so it is a fault rather than a second way to say "no overrides".
    const base = {
      vendors: { test: testVendor },
      roles: { cheap: { chain: ["test:m-chat"] } },
    };
    expect(() =>
      parseProviderConfig({ ...base, profiles: { default: { cheap: ["test:m-embed"] } } }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      parseProviderConfig({ ...base, profiles: { default: { cheap: ["test:m-embed"] } } }),
    ).toThrow(/profile "default" must be empty/);
    // An explicitly empty `default` says the same thing as omitting it.
    expect(parseProviderConfig({ ...base, profiles: { default: {} } }).profiles?.default).toEqual(
      {},
    );
    // The checked-in config does not declare the name it may only leave empty.
    expect(Object.keys(loadProviderConfig().profiles ?? {})).not.toContain("default");
  });

  it("reports every config fault as the typed ProviderConfigError", () => {
    // The composition root distinguishes a misconfigured deployment from a code
    // defect on this type; a schema fault arrives as the same class, with
    // valibot's error preserved as the cause.
    expect(() => parseCandidateKey("no-colon")).toThrow(ProviderConfigError);
    expect(() =>
      parseProviderConfig({ vendors: { test: testVendor }, roles: { cheap: { chain: [] } } }),
    ).toThrow(ProviderConfigError);
    expect(() => resolveChain(loadProviderConfig(), "no-such-role")).toThrow(ProviderConfigError);

    let schemaFault: unknown;
    try {
      parseProviderConfig({
        vendors: { test: { ...testVendor, protocol: "bogus" } },
        roles: { cheap: { chain: ["test:m-chat"] } },
      });
    } catch (err) {
      schemaFault = err;
    }
    expect(schemaFault).toBeInstanceOf(ProviderConfigError);
    expect((schemaFault as ProviderConfigError).cause).toBeInstanceOf(v.ValiError);
  });

  it("resolveChain returns candidates in chain order", () => {
    const config = {
      vendors: {
        test: testVendor,
        alt: {
          ...testVendor,
          apiKeyEnv: "ALT_KEY",
          models: {
            "alt-chat": {
              capabilities: ["generate" as const, "stream" as const],
              priceMicroUsdPerMTok: { in: 140, out: 280 },
            },
          },
        },
      },
      roles: { cheap: { chain: ["test:m-chat", "alt:alt-chat"] } },
    };
    const chain = resolveChain(config, "cheap");
    expect(chain.map((c) => `${c.vendor}:${c.modelId}`)).toEqual(["test:m-chat", "alt:alt-chat"]);
  });
});
