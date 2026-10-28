import { AdminLoginRequestSchema, type AdminLoginRequest, type AdminSession } from "@app/contracts";
import type { Context } from "hono";
import * as v from "valibot";
import { credentialMatches, isJsonContentType } from "./admin-auth";
import type { ApiEnv } from "../env";

/**
 * The admin login body and the session answer that follows it — one boundary whose
 * every miss is the same `false`, so a caller cannot tell a wrong password from a body
 * the server would not read.
 *
 * The declared type is checked before the body is read. `Request.json()` parses any
 * body whatever the header says; accepting that would make the documented
 * `application/json` contract advisory, and a browser form's own encodings — which a
 * cross-site page can send — indistinguishable from the intended request. Only an
 * explicit `application/json` (an optional `charset` parameter allowed) reaches the
 * parser and the constant-time credential comparison.
 */
export async function loginBodyMatches(c: Context<ApiEnv>, credential: string): Promise<boolean> {
  const body = await readLoginBody(c.req.header("content-type"), () => c.req.raw.json());
  if (body === null) return false;
  return credentialMatches(body.password, credential);
}

/**
 * The body read as two arguments — the declared type and the read itself — so the
 * order is a property of this function rather than of the caller: a type it will not
 * parse never invokes the read. That is what makes "the media type is the boundary"
 * observable; a read that runs before the check would hand any content type a parser.
 */
export async function readLoginBody(
  contentType: string | undefined,
  read: () => Promise<unknown>,
): Promise<AdminLoginRequest | null> {
  if (!isJsonContentType(contentType)) return null;
  let body: unknown;
  try {
    body = await read();
  } catch {
    return null;
  }
  const parsed = v.safeParse(AdminLoginRequestSchema, body);
  return parsed.success ? parsed.output : null;
}

/**
 * The probe's and the login's one answer shape: whether a live session is held, plus
 * the CSRF token the next write must echo. Typed against the shared contract, so a
 * field renamed or added on this side reddens the compile rather than a browser's
 * runtime parse.
 */
export function sessionBody(authenticated: boolean, csrfToken: string): AdminSession {
  return { authenticated, csrfToken };
}
