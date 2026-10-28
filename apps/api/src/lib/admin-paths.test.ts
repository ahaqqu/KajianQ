import { describe, expect, it } from "vite-plus/test";
import {
  ADMIN_API_PATH_PATTERN,
  ADMIN_API_PREFIX,
  ADMIN_COOKIE_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_ROUTE,
  isAdminApiPath,
} from "./admin-paths";

/**
 * The admin namespace boundary, without credential machinery. Two owners would let
 * the OpenAPI exclusion and the meter's path test disagree about the bare prefix.
 */
describe("admin namespace", () => {
  it("scopes the API to one prefix, with the session under it and a clean boundary", () => {
    expect(ADMIN_API_PREFIX).toBe("/v1/admin");
    expect(ADMIN_COOKIE_PATH).toBe(ADMIN_API_PREFIX);
    expect(ADMIN_LOGIN_PATH).toBe(`${ADMIN_API_PREFIX}${ADMIN_SESSION_ROUTE}`);
    expect(isAdminApiPath(ADMIN_API_PREFIX)).toBe(true);
    expect(isAdminApiPath(ADMIN_LOGIN_PATH)).toBe(true);
    expect(isAdminApiPath(`${ADMIN_API_PREFIX}/traces`)).toBe(true);
    // The SPA page's route is not the API namespace…
    expect(isAdminApiPath("/admin")).toBe(false);
    // …and a path that merely shares the characters is public: a bare prefix test
    // would silently exempt it from the public meter.
    expect(isAdminApiPath("/v1/administer")).toBe(false);
    expect(isAdminApiPath("/v1/")).toBe(false);
  });

  it("draws the OpenAPI exclusion exactly where the namespace predicate does", () => {
    for (const path of [
      ADMIN_API_PREFIX,
      ADMIN_LOGIN_PATH,
      `${ADMIN_API_PREFIX}/traces`,
      `${ADMIN_API_PREFIX}/traces/00000000-0000-4000-8000-000000000000`,
      "/v1/",
      "/v1/administer",
      "/v1/adminx",
      "/admin",
      "/",
    ]) {
      expect(ADMIN_API_PATH_PATTERN.test(path), path).toBe(isAdminApiPath(path));
    }
  });
});
