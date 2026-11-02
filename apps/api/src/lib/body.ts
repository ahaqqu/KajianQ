/**
 * The JSON request-body boundary shared by the public write routes.
 *
 * Decides media type, size, UTF-8, and JSON syntax BEFORE any route schema,
 * auth, store or pipeline stage runs, and reports each rejection with the code
 * and status the route answers. The invariant: a body is either decoded
 * losslessly and handed to the route's schema, or rejected with the documented
 * 4xx — never replacement-decoded into a different string (what `Request.text()`
 * does to invalid UTF-8), never silently truncated, never a server fault.
 */

import { isJsonMediaType, PUBLIC_JSON_MEDIA_TYPE } from "./media-type";

/** The largest JSON request body either public write route accepts, in bytes. */
export const BODY_MAX_BYTES = 64 * 1024;

/** The codes `readJsonBody` answers: the transport boundary, before any schema. */
export type BodyErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_encoding"
  | "invalid_json";

/** Every code a route's body parse answers: the reader's plus its schema's. */
export type BodyRejectionCode = BodyErrorCode | "invalid_request";

/**
 * The status each rejection answers. One map for every code the routes can
 * answer, and the route reads the status off the rejection, so neither route
 * can map the same code differently.
 */
export const REJECTION_STATUS: Record<BodyRejectionCode, 400 | 413 | 415> = {
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_json: 400,
  invalid_encoding: 400,
  invalid_request: 400,
};

/** The one published sentence per rejection code, read by the OpenAPI responses. */
export const REJECTION_EXPLANATION: Record<BodyRejectionCode, string> = {
  unsupported_media_type: "missing or non-JSON Content-Type",
  payload_too_large: `over the ${BODY_MAX_BYTES}-byte ceiling`,
  invalid_json: "not JSON",
  invalid_encoding: "not UTF-8",
  invalid_request: "failed the body schema",
};

const REJECTION_SUMMARY: Record<400 | 413 | 415, string> = {
  400: "Invalid request body",
  413: "Request body too large",
  415: "Unsupported media type",
};

/**
 * The published description of one rejection status, naming every code the map
 * assigns to it — a code added to the map is documented by construction.
 */
export function rejectionDescription(status: 400 | 413 | 415): string {
  const codes = (Object.keys(REJECTION_STATUS) as BodyRejectionCode[]).filter(
    (code) => REJECTION_STATUS[code] === status,
  );
  const named = codes.map((code) => `${code} (${REJECTION_EXPLANATION[code]})`);
  const list =
    named.length > 1 ? `${named.slice(0, -1).join(", ")}, or ${named[named.length - 1]}` : named[0];
  return `${REJECTION_SUMMARY[status]} — ${list ?? ""}`;
}

/** A body the boundary rejected; `detail` is log-only and never reaches the wire. */
export type BodyRejection = {
  success: false;
  error: BodyRejectionCode;
  status: 400 | 413 | 415;
  detail?: string;
};

export type BodyResult = { success: true; value: unknown } | BodyRejection;

/**
 * The one constructor for a rejection: the status comes from the map above,
 * never from the caller.
 */
export function reject(error: BodyRejectionCode, detail?: string): BodyRejection {
  return {
    success: false,
    error,
    status: REJECTION_STATUS[error],
    ...(detail !== undefined ? { detail } : {}),
  };
}

export type Warn = {
  warn(msg: string, fields?: Record<string, string | number | boolean | null>): void;
};

/** The longest a log detail may be, escape sequences included. */
export const LOG_DETAIL_MAX_LENGTH = 120;

/**
 * Text safe for a structured log line: control characters are escaped, so a
 * body carrying NUL padding cannot make the log record binary, and the detail
 * stays one line of at most `LOG_DETAIL_MAX_LENGTH` characters.
 */
export function loggable(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const piece = control ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    if (out.length + piece.length > LOG_DETAIL_MAX_LENGTH) break;
    out += piece;
  }
  return out;
}

/**
 * Emit the reader's one warn line and build the rejection it describes. The
 * route name namespaces the log (`chat`/`feedback`); `detail` is log-only and
 * already sanitized by the caller when it carries body-derived text.
 */
function rejectAndLog(
  log: Warn | undefined,
  route: string,
  error: BodyErrorCode,
  detail: string | undefined,
  fields?: Record<string, string | number | boolean | null>,
): BodyRejection {
  log?.warn(`${route}.body_${error}`, {
    ...(detail !== undefined ? { detail } : {}),
    ...fields,
  });
  return reject(error, detail);
}

/** A valid non-negative Content-Length, or null when absent/unparseable. */
function declaredBytes(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type ReadOutcome =
  | { kind: "body"; bytes: Uint8Array }
  | { kind: "too_large"; bytes: number }
  | { kind: "unreadable" };

/**
 * Read the body, stopping one byte over the ceiling: a chunked body declaring
 * no Content-Length is bounded here, and the reader is released without
 * buffering the rest.
 */
async function readAtMost(req: Request, limit: number): Promise<ReadOutcome> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const stream = req.body;
    if (stream === null) return { kind: "body", bytes: new Uint8Array(0) };
    reader = stream.getReader();
  } catch {
    return { kind: "unreadable" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large", bytes: total };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream releases on its own; the bytes already
      // read are the only ones this function owns.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "body", bytes };
}

/** The body as text only when it is exactly valid UTF-8; null otherwise. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read and JSON-parse a request body, or reject it with the documented code.
 * `route` names the log namespace (`chat`/`feedback`); `detail` is log-only —
 * routes answer the bare `{ error }` contract and never echo input bytes.
 */
export async function readJsonBody(req: Request, route: string, log?: Warn): Promise<BodyResult> {
  const header = req.headers.get("content-type");
  if (!isJsonMediaType(header, PUBLIC_JSON_MEDIA_TYPE)) {
    return rejectAndLog(
      log,
      route,
      "unsupported_media_type",
      "A JSON request body requires Content-Type: application/json.",
      { contentType: header === null ? "absent" : loggable(header) },
    );
  }
  const declared = declaredBytes(req);
  if (declared !== null && declared > BODY_MAX_BYTES) {
    return rejectAndLog(
      log,
      route,
      "payload_too_large",
      `The body declares ${declared} bytes; the ceiling is ${BODY_MAX_BYTES}.`,
      { declared, limit: BODY_MAX_BYTES },
    );
  }
  const read = await readAtMost(req, BODY_MAX_BYTES);
  if (read.kind === "too_large") {
    return rejectAndLog(
      log,
      route,
      "payload_too_large",
      `The body exceeds the ${BODY_MAX_BYTES}-byte ceiling.`,
      { limit: BODY_MAX_BYTES, read: read.bytes },
    );
  }
  if (read.kind === "unreadable") {
    log?.warn(`${route}.body_unreadable`);
    return reject("invalid_json");
  }
  const text = decodeUtf8(read.bytes);
  if (text === null) {
    return rejectAndLog(log, route, "invalid_encoding", "The body is not valid UTF-8.", {
      bytes: read.bytes.byteLength,
    });
  }
  try {
    return { success: true, value: JSON.parse(text) };
  } catch (err) {
    return rejectAndLog(
      log,
      route,
      "invalid_json",
      loggable(err instanceof Error ? err.message : "parse error"),
    );
  }
}
