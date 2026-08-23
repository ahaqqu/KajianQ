import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@app/infra";
import { buildHealth } from "./health";

describe("buildHealth", () => {
  it("returns ok Hello World payload", () => {
    const sink = vi.fn();
    const result = buildHealth({
      envName: "production",
      correlationId: "test-id",
      logger: createLogger({}, sink),
    });
    expect(result.status).toBe("ok");
    expect(result.schemaVersion).toBe(1);
    expect(result.message).toBe("Hello World");
  });
});
