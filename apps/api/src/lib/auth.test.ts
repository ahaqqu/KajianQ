import { describe, expect, it } from "vitest";
import type { D1Database } from "../cf-types";
import {
  createAnonymousSession,
  deleteUserCascade,
  resolveUserId,
} from "./auth";

function memoryD1() {
  const users = new Map<string, number>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const notes = new Map<string, { userId: string }>();

  const api = {
    prepare(sql: string) {
      const binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds.push(...args);
          return stmt;
        },
        async run() {
          if (sql.includes("INSERT INTO users")) {
            users.set(String(binds[0]), Number(binds[1]));
          } else if (sql.includes("INSERT INTO sessions")) {
            sessions.set(String(binds[0]), {
              userId: String(binds[1]),
              expiresAt: Number(binds[2]),
            });
          } else if (sql.includes("DELETE FROM notes")) {
            for (const [id, n] of notes) {
              if (n.userId === binds[0]) notes.delete(id);
            }
          } else if (sql.includes("DELETE FROM sessions")) {
            for (const [t, s] of sessions) {
              if (s.userId === binds[0]) sessions.delete(t);
            }
          } else if (sql.includes("DELETE FROM users")) {
            users.delete(String(binds[0]));
          }
          return { success: true };
        },
        async first<T>() {
          if (sql.includes("FROM sessions")) {
            const s = sessions.get(String(binds[0]));
            if (!s) return null;
            return { userId: s.userId, expiresAt: s.expiresAt } as T;
          }
          return null;
        },
      };
      return stmt;
    },
  };
  return api as unknown as D1Database;
}

describe("auth", () => {
  it("creates session and resolves bearer", async () => {
    const db = memoryD1();
    const session = await createAnonymousSession(db);
    const uid = await resolveUserId(db, `Bearer ${session.token}`);
    expect(uid).toBe(session.userId);
  });

  it("rejects missing bearer", async () => {
    const db = memoryD1();
    expect(await resolveUserId(db, undefined)).toBeNull();
  });

  it("cascades delete", async () => {
    const db = memoryD1();
    const s = await createAnonymousSession(db);
    await deleteUserCascade(db, s.userId);
    expect(await resolveUserId(db, `Bearer ${s.token}`)).toBeNull();
  });
});
