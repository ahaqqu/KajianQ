import { describe, expect, it } from "vite-plus/test";
import { computeCost } from "@app/infra";
import type { TraceProviderCall } from "@app/contracts";
import { ModelConfigPayloadError, adminTraceCallOf } from "./admin-detail";

/**
 * The admin detail's mirror half: "unresolved" must mean "no mirror row names this
 * model", never "a row names it but I could not read its price". The recorded
 * `costMicroUsd` stays the call's figure in every state.
 */

const call: TraceProviderCall = {
  stage: "generator",
  modelId: "m-chat",
  tokensIn: 10,
  tokensOut: 7,
  latencyMs: 100,
  costMicroUsd: 42,
};

const row = (config: Record<string, unknown>) => ({
  role: "generator",
  provider: "alpha",
  modelId: "m-chat",
  config,
  active: true,
  updatedAt: 0,
});

describe("adminTraceCallOf", () => {
  it("refuses a mirror row whose price it cannot read instead of reporting unresolved", () => {
    // The mirror DOES name the model: printing "not in the current provider config"
    // would be a false statement, so the read is refused instead.
    expect(() => adminTraceCallOf(call, [row({ priceMicroUsdPerMTok: "cheap" })])).toThrow(
      ModelConfigPayloadError,
    );
  });

  it("refuses a payload the contract's price bounds reject", () => {
    expect(() =>
      adminTraceCallOf(call, [row({ priceMicroUsdPerMTok: { in: 1.5, out: 3000 } })]),
    ).toThrow(ModelConfigPayloadError);
    expect(() => adminTraceCallOf(call, [row({})])).toThrow(ModelConfigPayloadError);
  });

  it("still reports unresolved when no row names the model", () => {
    expect(adminTraceCallOf(call, [])).toEqual({
      ...call,
      modelConfig: { status: "unresolved", matches: [] },
    });
  });

  it("keeps the recorded cost and reports consistency from the mirrored price", () => {
    const price = { in: 500, out: 3000 };
    const expected = computeCost(
      "m-chat",
      price,
      call.tokensIn,
      call.tokensOut,
      call.latencyMs,
    ).costMicroUsd;
    const result = adminTraceCallOf({ ...call, costMicroUsd: expected }, [
      row({ priceMicroUsdPerMTok: price }),
    ]);
    expect(result.costMicroUsd).toBe(expected);
    expect(result.modelConfig.status).toBe("consistent");
    expect(result.modelConfig.matches[0]?.priceMicroUsdPerMTok).toEqual(price);
  });
});
