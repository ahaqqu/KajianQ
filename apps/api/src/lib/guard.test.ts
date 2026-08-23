import { describe, expect, it } from "vitest";
import { newRouter } from "./guard";

describe("newRouter", () => {
  it("carries the app env generics and serves a route", async () => {
    const res = await newRouter()
      .get("/ping", (c) => c.json({ ok: true }))
      .request("/ping", {}, { ASSETS: { fetch } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
