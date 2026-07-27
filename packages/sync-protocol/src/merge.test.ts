import { describe, expect, it } from "vitest";
import { aliveNotes, mergeNotes } from "./merge";

describe("mergeNotes", () => {
  it("keeps newer updatedAt", () => {
    const r = mergeNotes(
      [{ id: "a", title: "old", body: "", updatedAt: 1 }],
      [{ id: "a", title: "new", body: "", updatedAt: 2 }],
    );
    expect(r[0]?.title).toBe("new");
  });

  it("delete wins", () => {
    const r = mergeNotes(
      [{ id: "a", title: "x", body: "", updatedAt: 2 }],
      [{ id: "a", title: "x", body: "", updatedAt: 1, deleted: true }],
    );
    expect(aliveNotes(r)).toHaveLength(0);
  });
});
