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

/**
 * The error envelope the auth routes actually return on 401 ("unauthorized"),
 * 429 ("rate_limited", from the global per-IP limiter) and 503 (the route's own
 * `errorCode` when auth is unconfigured).
 *
 * It exists because those statuses used to be documented with `DeletedUserSchema`
 * — the SUCCESS body — so the published contract claimed a 401 returns
 * `{deleted: true}`. Schemathesis caught it the first time it was able to run:
 * `DELETE /v1/auth/me` answered `{"error":"unauthorized"}` and violated the
 * documented schema. A doc claim that contradicts the code is a defect, not
 * documentation debt.
 */
export const AuthErrorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
});

export type AuthError = v.InferOutput<typeof AuthErrorSchema>;
