import * as v from "valibot";

export const HealthResponseSchema = v.object({
  status: v.literal("ok"),
  env: v.picklist(["development", "staging", "production"]),
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  message: v.pipe(v.string(), v.minLength(1)),
});

export type HealthResponse = v.InferOutput<typeof HealthResponseSchema>;

/** JSON error payload the global middleware answers with (rate limiting). */
export const HealthErrorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
});

export type HealthError = v.InferOutput<typeof HealthErrorSchema>;
