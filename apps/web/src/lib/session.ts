import { AuthResponseSchema, type AuthResponse } from "@app/contracts";
import * as v from "valibot";
import { apiFetch } from "./api";

const KEY = "apt.session";

export type ClientSession = AuthResponse;

export function loadSession(): ClientSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientSession;
    if (parsed.expiresAt < Date.now()) {
      localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: ClientSession): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}

/**
 * Deletes the account server-side and clears the local session.
 * Returns false (no-op) when there is no session to delete.
 */
export async function deleteSession(): Promise<boolean> {
  const session = loadSession();
  if (!session) return false;
  await apiFetch("/auth/me", { method: "DELETE", token: session.token });
  clearSession();
  return true;
}

export async function ensureSession(): Promise<ClientSession> {
  const existing = loadSession();
  if (existing) return existing;
  const res = await apiFetch("/auth/anonymous", { method: "POST" });
  if (!res.ok) throw new Error(`auth_${res.status}`);
  const body = v.parse(AuthResponseSchema, await res.json());
  saveSession(body);
  return body;
}
