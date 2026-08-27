import { describe, expect, it } from "vitest";
import { createMemoryConfigStore } from "./config-store";

describe("infra adapters", () => {
  it("config store", async () => {
    const cfg = createMemoryConfigStore({ a: "1" });
    expect(await cfg.get("a")).toBe("1");
    await cfg.set("b", "2");
    expect(await cfg.get("b")).toBe("2");
  });
});
