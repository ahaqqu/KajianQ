import {
  AdminSessionSchema,
  AdminTraceListSchema,
  AdminTraceDetailSchema,
  type AdminSession,
  type AdminTraceDetail,
  type AdminTraceList,
} from "@app/contracts";
import * as v from "valibot";

/**
 * The admin surface's client: `/v1/admin`, same-origin cookies, and the CSRF
 * header on the one write. The session is a cookie the browser holds (httpOnly),
 * so nothing here stores a token — and `credentials: "same-origin"` is what
 * carries it.
 *
 * Responses are parsed against the shared contracts before the UI sees them: an
 * admin screen that renders half a payload is a trap for the operator reading it,
 * so a shape mismatch is an error state, not a partially filled table.
 */
const ADMIN_BASE = "/v1/admin";

export class AdminClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminClientError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  csrf?: string;
  signal?: AbortSignal | undefined;
};

async function adminRequest(path: `/${string}`, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.csrf !== undefined) headers["X-CSRF-Token"] = options.csrf;
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const response = await fetch(`${ADMIN_BASE}${path}`, init);
  if (!response.ok) {
    // The server answers every miss with the same 401 body; the status is all the
    // UI needs to show "signed out" rather than a reason that would narrow a guess.
    throw new AdminClientError(response.status, `admin request failed: ${response.status}`);
  }
  return response;
}

async function parseBody<T>(response: Response, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const body: unknown = await response.json();
  return v.parse(schema, body);
}

/** The session probe: also the CSRF bootstrap (the cookie and the token arrive here). */
/** The session probe's answer: whether a session cookie is live, plus the CSRF
 * token that must ride the next write. */
export type AdminSessionResponse = AdminSession;

export async function fetchAdminSession(signal?: AbortSignal): Promise<AdminSession> {
  const response = await adminRequest("/session", { signal });
  return parseBody(response, AdminSessionSchema);
}

export async function logIn(password: string, csrfToken: string): Promise<AdminSession> {
  const response = await adminRequest("/session", {
    method: "POST",
    body: { password },
    csrf: csrfToken,
  });
  return parseBody(response, AdminSessionSchema);
}

export async function logOut(csrfToken: string): Promise<void> {
  await adminRequest("/session", { method: "DELETE", csrf: csrfToken });
}

/** A filtered, server-paginated page. Every dimension is a URL parameter so a page
 * of results can be shared verbatim. */
export type AdminTraceQuery = {
  q?: string;
  from?: string;
  to?: string;
  intent?: string;
  model?: string;
  refused?: string;
  filterRelaxed?: string;
  minLatencyMs?: string;
  minCostMicroUsd?: string;
  page?: string;
  pageSize?: string;
};

export async function fetchAdminTraces(
  query: AdminTraceQuery,
  signal?: AbortSignal,
): Promise<AdminTraceList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await adminRequest(`/traces${suffix}`, { signal });
  return parseBody(response, AdminTraceListSchema);
}

export async function fetchAdminTrace(id: string, signal?: AbortSignal): Promise<AdminTraceDetail> {
  const response = await adminRequest(`/traces/${encodeURIComponent(id)}`, { signal });
  return parseBody(response, AdminTraceDetailSchema);
}

/** The stable download URL: a plain GET, the session cookie is the whole credential,
 * and the response is the persisted artifact. Returned rather than fetched so the
 * caller can hand it to an anchor (the browser owns the download). */
export function adminRawTraceUrl(id: string): string {
  return `${ADMIN_BASE}/traces/${encodeURIComponent(id)}/raw`;
}
