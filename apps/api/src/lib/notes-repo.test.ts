import { describe, expect, it } from "vitest";
import { listNotes, syncNotes } from "./notes-repo";
import type { D1Database } from "../cf-types";

function memDb(): D1Database {
  const notes = new Map<
    string,
    {
      userId: string;
      title: string;
      body: string;
      updatedAt: number;
      deleted: number;
    }
  >();
  return {
    prepare(sql: string) {
      const binds: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          binds.push(...a);
          return stmt;
        },
        async all<T>() {
          if (sql.includes("FROM notes")) {
            const userId = String(binds[0]);
            const results = [...notes.entries()]
              .filter(([, n]) => n.userId === userId)
              .map(([id, n]) => ({
                id,
                title: n.title,
                body: n.body,
                updatedAt: n.updatedAt,
                deleted: n.deleted,
              }));
            return { results: results as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO notes")) {
            const [id, userId, title, body, updatedAt, deleted] = binds as [
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            notes.set(id, { userId, title, body, updatedAt, deleted });
          }
          return {};
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
}

describe("notes-repo", () => {
  it("syncs and lists alive notes", async () => {
    const db = memDb();
    const uid = "u1";
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await syncNotes(db, uid, [
      {
        id,
        title: "A",
        body: "b",
        updatedAt: 1,
        deleted: false,
      },
    ]);
    const listed = await listNotes(db, uid);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("A");
  });
});
