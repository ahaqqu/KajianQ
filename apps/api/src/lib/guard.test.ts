import { describe, expect, it, vi } from "vitest";
import { authGuard, newRouter } from "./guard";

vi.mock("./auth", () => ({
  resolveUserId: vi.fn(async (_db: unknown, header?: string) =>
    header === "Bearer good" ? "u1" : null,
  ),
}));

const env = { ASSETS: { fetch }, DB: {} as never };

function app() {
  return newRouter().get("/secure", authGuard, (c) =>
    c.json({ userId: c.get("authed").userId }),
  );
}

describe("authGuard", () => {
  it("rejects requests without a valid token", async () => {
    const res = await app().request("/secure", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("resolves the authed context for valid tokens", async () => {
    const res = await app().request(
      "/secure",
      { headers: { Authorization: "Bearer good" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u1" });
  });
});
