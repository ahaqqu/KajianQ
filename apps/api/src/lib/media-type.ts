/**
 * The repo's one "is this a JSON body?" rule, with its strictness explicit.
 *
 * Two surfaces need two rules, and they must not be two implementations:
 *
 *  - the public write boundary (`body.ts`) follows RFC 6839: `application/json`
 *    or `application/*+json` with a non-empty registered subtype, any parameter
 *    (`; charset=utf-8`) ignored — JSON decodes as UTF-8 whatever the header
 *    claims, and the decoder is the authority on the bytes;
 *  - the admin login (`admin-login.ts`) admits only `application/json` with an
 *    empty or `charset=` parameter, because a browser form's own encodings must
 *    not be readable as the intended request.
 */

export type JsonMediaTypeRule = {
  /** Admit a structured `application/*+json` suffix (RFC 6839) beside `application/json`. */
  structuredSuffix: boolean;
  /** Admit arbitrary parameters (`; charset=utf-8`, `; boundary=…`). */
  anyParameters: boolean;
};

/** The public write boundary's rule: the RFC 6839 structured suffix, any parameter. */
export const PUBLIC_JSON_MEDIA_TYPE: JsonMediaTypeRule = {
  structuredSuffix: true,
  anyParameters: true,
};

/** The admin login's rule: `application/json` only, an optional `charset`, no suffix. */
export const ADMIN_JSON_MEDIA_TYPE: JsonMediaTypeRule = {
  structuredSuffix: false,
  anyParameters: false,
};

/** Token characters a media subtype may carry (RFC 7230 §3.2.6). */
const MEDIA_SUBTYPE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

/** The parameter the admin rule admits, and only with a value. */
const CHARSET_PARAMETER = /^charset=[^;\s]+$/i;

/**
 * Whether a declared `Content-Type` names a JSON body under `rule`. The media
 * type is case-insensitive and parameters are trimmed; the structured suffix
 * needs a registered (hence non-empty and token-only) subtype, so
 * `application/+json` is not JSON.
 */
export function isJsonMediaType(
  value: string | null | undefined,
  rule: JsonMediaTypeRule,
): boolean {
  if (value === null || value === undefined) return false;
  const [rawMedia, ...parameters] = value.split(";").map((part) => part.trim());
  const media = (rawMedia ?? "").toLowerCase();
  if (
    !rule.anyParameters &&
    !parameters.every((parameter) => parameter === "" || CHARSET_PARAMETER.test(parameter))
  ) {
    return false;
  }
  if (media === "application/json") return true;
  if (!rule.structuredSuffix) return false;
  const prefix = "application/";
  const suffix = "+json";
  if (!media.startsWith(prefix) || !media.endsWith(suffix)) return false;
  return MEDIA_SUBTYPE.test(media.slice(prefix.length, media.length - suffix.length));
}

/** The admin login's declared-type rule, under the name that surface uses. */
export function isJsonContentType(value: string | undefined): boolean {
  return isJsonMediaType(value, ADMIN_JSON_MEDIA_TYPE);
}
