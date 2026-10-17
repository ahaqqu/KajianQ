import { describe, expect, it } from "vite-plus/test";
import { computeCost } from "./chat-wire";
import { loadProviderConfig } from "./provider-config";
import expectedPrices from "./price-unit.expected.json";

/** Every catalog entry's price in micro-USD per MTok — the unit `models.json`'s
 * header declares (1 USD = 1e6 micro-USD, so a $0.50/MTok input price is
 * 500000). Holding the whole catalog as one expectation keeps a re-price to a
 * single edit, and a price re-entered on the USD scale fails here by key at any
 * magnitude instead of slipping under a floor.
 *
 * The expectation lives in JSON because the boundary gate bars vendor names
 * from engine `.ts` sources and a "vendor:model" key is one. */

describe("price unit", () => {
  it("pins every catalog price in micro-USD per MTok", () => {
    const actual: Record<string, { in: number; out: number }> = {};
    for (const [vendor, vendorConfig] of Object.entries(loadProviderConfig().vendors)) {
      for (const [modelId, model] of Object.entries(vendorConfig.models)) {
        actual[`${vendor}:${modelId}`] = model.priceMicroUsdPerMTok;
      }
    }
    expect(actual).toEqual(expectedPrices);
  });

  it("applies a known price to a known token count", () => {
    // The header's own example: $0.50/MTok over a full MTok of input.
    expect(computeCost("m-model", { in: 500_000, out: 0 }, 1_000_000, 0, 1).costMicroUsd).toBe(
      500_000,
    );
    // Both sides priced: 8,000 input at $0.025/MTok and 400 output at
    // $0.05/MTok is 200 + 20 = 220 micro-USD.
    expect(computeCost("m-model", { in: 25_000, out: 50_000 }, 8_000, 400, 1).costMicroUsd).toBe(
      220,
    );
  });
});
