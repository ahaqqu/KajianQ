/**
 * The admin namespace's one spelling: the prefix, the routes derived from it, and
 * the boundary predicate. No credential machinery lives here, so the OpenAPI check
 * script and the route-coverage test import the boundary without pulling in the
 * session module's crypto, cookie and env bindings.
 */

/**
 * The admin surface's API prefix. It sits under the public API namespace so the proxy
 * that already serves `/v1` carries the admin read surface too; a top-level namespace
 * would be a deployment change (a new proxy location) rather than a code change.
 */
export const ADMIN_API_PREFIX = "/v1/admin";

/** The session and CSRF cookies' path: the admin API prefix, never the whole API. */
export const ADMIN_COOKIE_PATH = ADMIN_API_PREFIX;

/** The session route, relative to the prefix: every admin router is mounted at
 * `ADMIN_API_PREFIX` and registers its paths without repeating it. */
export const ADMIN_SESSION_ROUTE = "/session";

/** The login route's absolute path. The admin middleware keys its tighter budget off this one
 * spelling, so a route move cannot leave credential guessing on the browsing budget. */
export const ADMIN_LOGIN_PATH = `${ADMIN_API_PREFIX}${ADMIN_SESSION_ROUTE}`;

/** True for the admin namespace itself and every path under it, and for nothing that
 * merely shares the prefix's characters (`/v1/administer` is a public path). */
export function isAdminApiPath(path: string): boolean {
  return path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`);
}

/** The same boundary as a pattern, for consumers that take a RegExp (hono-openapi's
 * `exclude`): the prefix itself and everything under it, nothing that merely shares
 * its characters. A test asserts it agrees with `isAdminApiPath` path by path. */
export const ADMIN_API_PATH_PATTERN = new RegExp(
  `^${ADMIN_API_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`,
);
