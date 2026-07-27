import type { AuthResponse } from "@app/shared-zod";
import type { D1Database } from "../cf-types";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createAnonymousSession(
  db: D1Database,
): Promise<AuthResponse> {
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 30 * DAY_MS;
  await db
    .prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
    .bind(userId, now)
    .run();
  await db
    .prepare(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(token, userId, expiresAt)
    .run();
  return { userId, token, expiresAt };
}

export async function resolveUserId(
  db: D1Database,
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT user_id as userId, expires_at as expiresAt FROM sessions WHERE token = ?",
    )
    .bind(token)
    .first<{ userId: string; expiresAt: number }>();
  if (!row) return null;
  if (row.expiresAt < Date.now()) return null;
  return row.userId;
}

export async function deleteUserCascade(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db.prepare("DELETE FROM notes WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}
