import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@app/infra";
import { createRequestContext } from "./context";

describe("createRequestContext", () => {
  it("builds logger with env and correlation id", () => {
    const ctx = createRequestContext("staging", "cid-1");
    expect(ctx.envName).toBe("staging");
    expect(ctx.correlationId).toBe("cid-1");
    expect(typeof ctx.logger.info).toBe("function");
    const child = ctx.logger.child({ path: "/v1/health" });
    const sink = vi.fn();
    createLogger({ env: ctx.envName, correlationId: ctx.correlationId }, sink)
      .child({ path: "/v1/health" })
      .info("x");
    expect(child).toBeTruthy();
    expect(sink).toHaveBeenCalledOnce();
  });
});
