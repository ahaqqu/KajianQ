/**
 * Shared API client: the single place that owns the /v1 base path,
 * Authorization Bearer, JSON, and X-Correlation-Id headers. The server
 * echoes the correlation id into logs, so every fetch carries one.
 */
const API_BASE = "/v1";

export type ApiInit = Omit<RequestInit, "headers" | "signal"> & {
  token?: string;
  signal?: AbortSignal | undefined;
};

export async function apiFetch(
  path: `/${string}`,
  init: ApiInit = {},
): Promise<Response> {
  const { token, signal, ...rest } = init;
  const headers: Record<string, string> = {
    "X-Correlation-Id": crypto.randomUUID(),
  };
  if (rest.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const req: RequestInit = { ...rest, headers };
  if (signal) req.signal = signal;
  return fetch(`${API_BASE}${path}`, req);
}
