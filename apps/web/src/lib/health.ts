import {
  HealthResponseSchema,
  type HealthResponse,
} from "@app/shared-zod";

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const init: RequestInit = signal ? { signal } : {};
  const res = await fetch("/v1/health", init);
  if (!res.ok) {
    throw new Error(`health_http_${res.status}`);
  }
  const json: unknown = await res.json();
  return HealthResponseSchema.parse(json);
}
