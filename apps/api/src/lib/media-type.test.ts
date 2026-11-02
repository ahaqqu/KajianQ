import { describe, expect, it } from "vite-plus/test";
import { isJsonContentType, isJsonMediaType, PUBLIC_JSON_MEDIA_TYPE } from "./media-type";

/**
 * The one JSON media-type predicate, and the two strictness rules it serves:
 * the public write boundary takes RFC 6839's structured suffix with any
 * parameter, while the admin login takes `application/json` with an optional
 * `charset`. The row where they differ is pinned, so neither rule can drift
 * into the other silently.
 */

describe("isJsonMediaType — the public body rule", () => {
  it("accepts application/json and a structured suffix, whatever the parameters", () => {
    for (const value of [
      "application/json",
      "Application/JSON; charset=utf-8",
      "application/vnd.kajianq+json",
      "application/problem+json; charset=utf-8",
      'application/ld+json;profile="https://example.test/ctx"',
    ]) {
      expect(isJsonMediaType(value, PUBLIC_JSON_MEDIA_TYPE), value).toBe(true);
    }
  });

  it("rejects a missing header, a non-JSON type and an empty suffix subtype", () => {
    for (const value of [
      null,
      undefined,
      "",
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/json-patch",
      "application/+json",
      "application/ +json",
      "json",
    ]) {
      expect(isJsonMediaType(value, PUBLIC_JSON_MEDIA_TYPE), String(value)).toBe(false);
    }
  });
});

describe("isJsonMediaType — the two rules stay apart where they must", () => {
  it("pins the structured suffix the public boundary takes and the admin login does not", () => {
    // The difference is deliberate: the public boundary follows RFC 6839 and
    // RFC 8259, while the admin login admits only the declared JSON type so a
    // browser form's own encoding cannot reach its parser.
    expect(isJsonMediaType("application/vnd.kajianq+json", PUBLIC_JSON_MEDIA_TYPE)).toBe(true);
    expect(isJsonContentType("application/vnd.kajianq+json")).toBe(false);
  });

  it("keeps the admin rule to application/json with an optional charset", () => {
    for (const value of ["application/json", "application/json; charset=utf-8"]) {
      expect(isJsonContentType(value), value).toBe(true);
    }
    for (const value of [
      undefined,
      "",
      "text/plain",
      "application/json; foo=bar",
      "application/+json",
    ]) {
      expect(isJsonContentType(value), String(value)).toBe(false);
    }
  });
});
