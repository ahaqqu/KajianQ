import {
  HealthResponseSchema,
  type HealthResponse,
} from "@app/contracts";
import * as v from "valibot";
import { apiFetch } from "./api";

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const res = await apiFetch("/health", { signal });
  if (!res.ok) {
    throw new Error(`health_http_${res.status}`);
  }
  const json: unknown = await res.json();
  return v.parse(HealthResponseSchema, json);
}
