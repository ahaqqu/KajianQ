import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createMemoryObjectStore } from "./object-store";

describe("MemoryObjectStore", () => {
  it("put get delete list (Effect-shaped seam, ADR-0027 d7)", async () => {
    const s = createMemoryObjectStore();
    await Effect.runPromise(s.put("a/b", "hello"));
    const got = await Effect.runPromise(s.get("a/b"));
    expect(new TextDecoder().decode(got!)).toBe("hello");
    expect(await Effect.runPromise(s.list("a/"))).toEqual(["a/b"]);
    await Effect.runPromise(s.delete("a/b"));
    expect(await Effect.runPromise(s.get("a/b"))).toBeNull();
  });
});