import { describe, expect, it } from "vitest";
import {
  createAnonymousSession,
  deleteUserCascade,
  resolveUserId,
} from "./auth";
import { createMemoryD1 } from "./memory-d1";

describe("auth", () => {
  it("creates session and resolves bearer", async () => {
    const db = createMemoryD1();
    const session = await createAnonymousSession(db);
    const uid = await resolveUserId(db, `Bearer ${session.token}`);
    expect(uid).toBe(session.userId);
  });

  it("rejects missing bearer", async () => {
    const db = createMemoryD1();
    expect(await resolveUserId(db, undefined)).toBeNull();
  });

  it("rejects an empty bearer token", async () => {
    const db = createMemoryD1();
    expect(await resolveUserId(db, "Bearer   ")).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const db = createMemoryD1();
    expect(await resolveUserId(db, "Bearer nope")).toBeNull();
  });

  it("rejects an expired session", async () => {
    const db = createMemoryD1();
    await db
      .prepare(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      )
      .bind("tok", "u1", Date.now() - 1)
      .run();
    expect(await resolveUserId(db, "Bearer tok")).toBeNull();
  });

  it("cascades delete across notes, sessions, and users", async () => {
    const db = createMemoryD1();
    const s = await createAnonymousSession(db);
    await db
      .prepare(
        `INSERT INTO notes (id, user_id, title, body, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted
         WHERE notes.user_id = excluded.user_id`,
      )
      .bind("n1", s.userId, "t", "b", 1, 0)
      .run();
    await deleteUserCascade(db, s.userId);
    expect(await resolveUserId(db, `Bearer ${s.token}`)).toBeNull();
    const remaining = await db
      .prepare(
        `SELECT id, title, body, updated_at as updatedAt, deleted
         FROM notes WHERE user_id = ?`,
      )
      .bind(s.userId)
      .all<{ id: string }>();
    expect(remaining.results).toHaveLength(0);
  });
});
