import { z } from "zod";

export const SessionSchema = z.object({
  userId: z.string().uuid(),
  token: z.string().min(16),
  expiresAt: z.number().int().positive(),
});

export type Session = z.infer<typeof SessionSchema>;

export const AuthResponseSchema = z.object({
  userId: z.string().uuid(),
  token: z.string().min(16),
  expiresAt: z.number().int().positive(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
