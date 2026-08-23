import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { HealthResponseSchema } from "./health";

describe("HealthResponseSchema", () => {
  it("accepts valid health payload", () => {
    const result = v.safeParse(HealthResponseSchema, {
      status: "ok",
      env: "development",
      schemaVersion: 1,
      message: "Hello World",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing message", () => {
    const result = v.safeParse(HealthResponseSchema, {
      status: "ok",
      env: "staging",
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid env", () => {
    const result = v.safeParse(HealthResponseSchema, {
      status: "ok",
      env: "local",
      schemaVersion: 1,
      message: "x",
    });
    expect(result.success).toBe(false);
  });
});
