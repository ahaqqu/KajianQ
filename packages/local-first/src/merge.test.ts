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

  it("breaks exact updatedAt ties deterministically, not by argument order", () => {
    const x = { id: "a", title: "apple", body: "", updatedAt: 5 };
    const y = { id: "a", title: "banana", body: "", updatedAt: 5 };
    const ab = mergeNotes([x], [y]);
    const ba = mergeNotes([y], [x]);
    expect(ab).toEqual(ba);
    // Lexicographically greater payload wins regardless of order.
    expect(ab[0]?.title).toBe("banana");
  });

  it("prefers the deleted row on an exact tie (delete wins once seen)", () => {
    const live = { id: "a", title: "x", body: "", updatedAt: 5 };
    const gone = { id: "a", title: "x", body: "", updatedAt: 5, deleted: true };
    expect(mergeNotes([live], [gone])[0]?.deleted).toBe(true);
    expect(mergeNotes([gone], [live])[0]?.deleted).toBe(true);
  });

  it("normalizes deleted:false vs undefined so ties stay commutative", () => {
    const x = { id: "a", title: "x", body: "", updatedAt: 5, deleted: false };
    const y = { id: "a", title: "x", body: "", updatedAt: 5 };
    expect(mergeNotes([x], [y])).toEqual(mergeNotes([y], [x]));
  });
});
