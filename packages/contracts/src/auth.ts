import * as v from "valibot";

/**
 * Anonymous-session auth contracts (ADR-0017, ticket #10): the request-less
 * `POST /v1/auth/anonymous` and the self-deletion `DELETE /v1/auth/me`. The
 * token is opaque to the client — it is minted, handed over once, and stored
 * hashed server-side; the contract never describes its format.
 */

/** The minted anonymous session handed to the client (token leaves once). */
export const AnonymousSessionSchema = v.object({
  /** Bearer token for the `Authorization` header on guarded routes. */
  token: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  /** Epoch milliseconds at which the session stops resolving. */
  expiresAt: v.pipe(v.number(), v.integer()),
});

export type AnonymousSession = v.InferOutput<typeof AnonymousSessionSchema>;

/** The `DELETE /v1/auth/me` acknowledgement. */
export const DeletedUserSchema = v.object({
  deleted: v.literal(true),
});

export type DeletedUser = v.InferOutput<typeof DeletedUserSchema>;
