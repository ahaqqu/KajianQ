import { describe, expect, it } from "vitest";
import { requireDb } from "./db";

describe("requireDb", () => {
  it("throws when unbound", () => {
    expect(() => requireDb({ ASSETS: { fetch } })).toThrow("db_unbound");
  });

  it("returns db", () => {
    const DB = { prepare: () => ({}) } as never;
    expect(requireDb({ ASSETS: { fetch }, DB })).toBe(DB);
  });
});
