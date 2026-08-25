import { describe, expect, it } from "vitest";
import { createMemoryD1 } from "./memory-d1";
import { listNotes, syncNotes } from "./notes-repo";

const ID = "550e8400-e29b-41d4-a716-446655440000";

const alive = (title: string, updatedAt: number) => ({
  id: ID,
  title,
  body: "b",
  updatedAt,
  deleted: false,
});

describe("notes-repo", () => {
  it("syncs and lists alive notes", async () => {
    const db = createMemoryD1();
    await syncNotes(db, "u1", [alive("A", 1)]);
    const listed = await listNotes(db, "u1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("A");
  });

  it("upserts on re-sync (ON CONFLICT update path)", async () => {
    const db = createMemoryD1();
    await syncNotes(db, "u1", [alive("A", 1)]);
    await syncNotes(db, "u1", [alive("A2", 2)]);
    const listed = await listNotes(db, "u1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("A2");
  });

  it("rejects a cross-user upsert of the same id (per-user guard)", async () => {
    const db = createMemoryD1();
    await syncNotes(db, "u1", [alive("mine", 1)]);
    // u2 merges the same id; the upsert's WHERE notes.user_id guard no-ops,
    // so u1's row survives and nothing persists for u2.
    await syncNotes(db, "u2", [alive("stolen", 2)]);
    const u1Notes = await listNotes(db, "u1");
    expect(u1Notes[0]?.title).toBe("mine");
    expect(await listNotes(db, "u2")).toHaveLength(0);
  });

  it("fails loudly on a statement the double does not know", async () => {
    const db = createMemoryD1();
    await expect(db.prepare("DROP TABLE notes").run()).rejects.toThrow(
      /memory-d1/,
    );
  });
});
