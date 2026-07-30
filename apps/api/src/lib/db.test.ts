import { describe, expect, it } from "vitest";
import { DbUnboundError, requireDb } from "./db";

describe("requireDb", () => {
  it("throws a typed DbUnboundError when unbound", () => {
    expect(() => requireDb({ ASSETS: { fetch } })).toThrow(DbUnboundError);
    expect(() => requireDb({ ASSETS: { fetch } })).toThrow("db_unbound");
  });

  it("returns db", () => {
    const DB = { prepare: () => ({}) } as never;
    expect(requireDb({ ASSETS: { fetch }, DB })).toBe(DB);
  });
});
