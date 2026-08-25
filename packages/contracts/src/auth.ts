import * as v from "valibot";

export const AuthResponseSchema = v.object({
  userId: v.pipe(v.string(), v.uuid()),
  token: v.pipe(v.string(), v.minLength(16)),
  expiresAt: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type AuthResponse = v.InferOutput<typeof AuthResponseSchema>;
