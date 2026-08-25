import { describe, expect, it } from "vitest";
import { migrateToLatest, migrateV1ToV2, type NotesState } from "./migrations";

describe("migrations", () => {
  it("upgrades v1 to v2", () => {
    const v2 = migrateV1ToV2({ schemaVersion: 1, notes: [] });
    expect(v2.schemaVersion).toBe(2);
  });

  it("carries notes through v1 → v2 unchanged", () => {
    const notes = [{ id: "a", title: "t", body: "b", updatedAt: 1 }];
    expect(migrateV1ToV2({ schemaVersion: 1, notes }).notes).toEqual(notes);
  });

  it("leaves v2 snapshots untouched, clock floor included", () => {
    const snap: NotesState = { schemaVersion: 2, notes: [], clockFloor: 123 };
    expect(migrateV1ToV2(snap)).toBe(snap);
    expect(migrateToLatest(snap)).toBe(snap);
  });

  it("migrateToLatest is idempotent at v2", () => {
    const s = migrateToLatest({ schemaVersion: 2, notes: [] });
    expect(s.schemaVersion).toBe(2);
  });
});
