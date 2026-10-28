import { AdminLoginRequestSchema } from "@app/contracts";
import type { Context } from "hono";
import * as v from "valibot";
import { credentialMatches, isJsonContentType } from "./admin-auth";
import type { ApiEnv } from "../env";

/**
 * The admin login body: the media type, the contract, then the credential — one
 * boundary whose every miss is the same `false`, so a caller cannot tell a wrong
 * password from a body the server would not read.
 *
 * The declared type is checked before the body is parsed. `c.req.raw.json()` parses
 * any body whatever the header says; accepting that would make the documented
 * `application/json` contract advisory, and a browser form's own encodings — which
 * a cross-site page can send — indistinguishable from the intended request. Only an
 * explicit `application/json` (an optional `charset` parameter allowed) reaches the
 * parser and the constant-time credential comparison.
 */
export async function loginBodyMatches(c: Context<ApiEnv>, credential: string): Promise<boolean> {
  if (!isJsonContentType(c.req.header("content-type"))) return false;
  let body: unknown;
  try {
    body = await c.req.raw.json();
  } catch {
    body = null;
  }
  const parsed = v.safeParse(AdminLoginRequestSchema, body);
  if (!parsed.success) return false;
  return credentialMatches(parsed.output.password, credential);
}
