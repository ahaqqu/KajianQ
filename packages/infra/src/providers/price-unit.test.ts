import { describe, expect, it } from "vite-plus/test";
import { computeCost } from "./chat-wire";
import { loadProviderConfig, resolveChain } from "./provider-config";

/** Lowest per-MTok price in micro-USD any allowlist entry can plausibly carry:
 * every candidate is a paid model whose published rate is at least $0.042/MTok
 * (the decision model). A non-zero price below this floor is a price written on
 * the USD-per-MTok scale — ×1000 low — instead of the declared micro-USD one. */
const CHEAPEST_PLAUSIBLE_MICRO_USD_PER_MTOK = 42_000;

describe("price unit", () => {
  it("charges a whole MTok of tokens at the price the config declares", () => {
    // The unit `models.json`'s header declares: 1 USD = 1e6 micro-USD, so a
    // $0.50/MTok input price is 500000 and one MTok of input costs $0.50.
    expect(computeCost("m-model", { in: 500_000, out: 0 }, 1_000_000, 0, 1).costMicroUsd).toBe(
      500_000,
    );
  });

  it("records the generator's 8K-token call from the checked-in price", () => {
    const [generator] = resolveChain(loadProviderConfig(), "generator");
    if (!generator) throw new Error("the generator role resolves to no candidate");
    const price = generator.modelConfig.priceMicroUsdPerMTok;
    // $0.14/$0.28 per MTok, read back through the declared unit.
    expect(price.in / 1_000_000).toBe(0.14);
    expect(price.out / 1_000_000).toBe(0.28);
    // 8,000 input tokens at $0.14/MTok is 0.00112 USD = 1,120 micro-USD.
    expect(computeCost(generator.modelId, price, 8_000, 0, 1).costMicroUsd).toBe(1_120);
  });

  it("keeps every non-zero price on the micro-USD scale", () => {
    for (const [vendor, vendorConfig] of Object.entries(loadProviderConfig().vendors)) {
      for (const [modelId, model] of Object.entries(vendorConfig.models)) {
        const { in: priceIn, out: priceOut } = model.priceMicroUsdPerMTok;
        for (const price of [priceIn, priceOut]) {
          if (price === 0) continue;
          expect(
            price,
            `${vendor}:${modelId} is priced below ${CHEAPEST_PLAUSIBLE_MICRO_USD_PER_MTOK} micro-USD per MTok`,
          ).toBeGreaterThanOrEqual(CHEAPEST_PLAUSIBLE_MICRO_USD_PER_MTOK);
        }
      }
    }
  });
});
