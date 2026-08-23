import { describe, expect, it } from "vitest";
import { createMemoryObjectStore } from "./object-store";

describe("MemoryObjectStore", () => {
  it("put get delete list", async () => {
    const s = createMemoryObjectStore();
    await s.put("a/b", "hello");
    expect(new TextDecoder().decode((await s.get("a/b"))!)).toBe("hello");
    expect(await s.list("a/")).toEqual(["a/b"]);
    await s.delete("a/b");
    expect(await s.get("a/b")).toBeNull();
  });
});
