import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  env: z.enum(["development", "staging", "production"]),
  schemaVersion: z.number().int().positive(),
  message: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
