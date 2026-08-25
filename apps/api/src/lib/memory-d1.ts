import type { D1Database } from "../cf-types";

/**
 * Structured in-memory D1 test double for repo/auth unit tests.
 *
 * Statements are normalized (whitespace-collapsed) and matched *exactly*:
 * an altered or unknown query throws instead of silently matching a
 * substring (the failure mode of the old `sql.includes(...)` fakes), so a
 * repo SQL change fails its test loudly at the exact statement that moved.
 * Models the users/sessions/notes tables, including the notes upsert's
 * per-user guard (`WHERE notes.user_id = excluded.user_id`).
 */

type NoteRow = {
  userId: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted: number;
};

type Verb = "run" | "first" | "all";
type Handler = Partial<Record<Verb, (binds: unknown[]) => unknown>>;

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function createMemoryD1(): D1Database {
  const users = new Map<string, number>(); // id -> created_at
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const notes = new Map<string, NoteRow>();

  const handlers: Record<string, Handler> = {
    [norm("INSERT INTO users (id, created_at) VALUES (?, ?)")]: {
      run: (b) => void users.set(String(b[0]), Number(b[1])),
    },
    [norm(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
    )]: {
      run: (b) =>
        void sessions.set(String(b[0]), {
          userId: String(b[1]),
          expiresAt: Number(b[2]),
        }),
    },
    [norm(
      "SELECT user_id as userId, expires_at as expiresAt FROM sessions WHERE token = ?",
    )]: {
      first: (b) => sessions.get(String(b[0])) ?? null,
    },
    [norm(
      `SELECT id, title, body, updated_at as updatedAt, deleted
       FROM notes WHERE user_id = ?`,
    )]: {
      all: (b) =>
        [...notes.entries()]
          .filter(([, n]) => n.userId === b[0])
          .map(([id, n]) => ({
            id,
            title: n.title,
            body: n.body,
            updatedAt: n.updatedAt,
            deleted: n.deleted,
          })),
    },
    [norm(
      `INSERT INTO notes (id, user_id, title, body, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted
       WHERE notes.user_id = excluded.user_id`,
    )]: {
      run: (b) => {
        const id = String(b[0]);
        const userId = String(b[1]);
        const existing = notes.get(id);
        // ON CONFLICT upsert guarded per-user: the real statement no-ops
        // when the id belongs to another user.
        if (existing && existing.userId !== userId) return;
        notes.set(id, {
          userId,
          title: String(b[2]),
          body: String(b[3]),
          updatedAt: Number(b[4]),
          deleted: Number(b[5]),
        });
      },
    },
    [norm("DELETE FROM notes WHERE user_id = ?")]: {
      run: (b) => {
        for (const [id, n] of notes) if (n.userId === b[0]) notes.delete(id);
      },
    },
    [norm("DELETE FROM sessions WHERE user_id = ?")]: {
      run: (b) => {
        for (const [token, s] of sessions) {
          if (s.userId === b[0]) sessions.delete(token);
        }
      },
    },
    [norm("DELETE FROM users WHERE id = ?")]: {
      run: (b) => void users.delete(String(b[0])),
    },
  };

  function dispatch(sql: string, verb: Verb, binds: unknown[]): unknown {
    const handler = handlers[norm(sql)]?.[verb];
    if (!handler) {
      throw new Error(`memory-d1: no ${verb} handler for: ${norm(sql)}`);
    }
    return handler(binds);
  }

  return {
    prepare(sql: string) {
      const binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds.push(...args);
          return stmt;
        },
        async run() {
          dispatch(sql, "run", binds);
          return { success: true };
        },
        async first<T>() {
          return dispatch(sql, "first", binds) as T | null;
        },
        async all<T>() {
          return { results: dispatch(sql, "all", binds) as T[] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}
