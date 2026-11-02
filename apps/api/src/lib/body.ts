/**
 * The JSON request-body boundary shared by the public write routes.
 *
 * Decides media type, size, UTF-8, and JSON syntax BEFORE any route schema,
 * auth, store or pipeline stage runs, and reports each refusal with the code
 * and status the route answers. The invariant: a body is either decoded
 * losslessly and handed to the route's schema, or refused with the documented
 * 4xx — never replacement-decoded into a different string (what `Request.text()`
 * does to invalid UTF-8), never silently truncated, never a server fault.
 */

/** The largest JSON request body either public write route accepts, in bytes. */
export const BODY_MAX_BYTES = 64 * 1024;

export type BodyErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_encoding"
  | "invalid_json";

/** The status each refusal answers; every route uses this one mapping. */
const REFUSAL_STATUS: Record<BodyErrorCode, 400 | 413 | 415> = {
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_encoding: 400,
  invalid_json: 400,
};

export type BodyRefusal = {
  success: false;
  error: BodyErrorCode;
  status: 400 | 413 | 415;
  detail?: string;
};

export type BodyResult = { success: true; value: unknown } | BodyRefusal;

/**
 * What a route's body parse answers: the reader's refusals plus the route
 * schema's own `invalid_request`. The status travels with the code so the two
 * routes cannot map the same refusal differently.
 */
export type RequestRefusal = {
  success: false;
  error: BodyErrorCode | "invalid_request";
  status: 400 | 413 | 415;
  detail?: string;
};

export type Warn = {
  warn(msg: string, fields?: Record<string, string | number | boolean | null>): void;
};

/**
 * The media type when the header is JSON: `application/json` or a structured
 * `application/*+json`. Any parameter (`; charset=utf-8`) is ignored — JSON is
 * decoded as UTF-8 regardless, and the decoder is the authority on the bytes.
 */
function jsonMediaType(header: string | null): string | null {
  if (header === null) return null;
  const media = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (media === "application/json") return media;
  if (media.startsWith("application/") && media.endsWith("+json")) return media;
  return null;
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
 * Text safe for a structured log line: control characters are escaped, so a
 * body carrying NUL padding cannot make the log record binary, and the detail
 * stays one bounded line.
 */
function loggable(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    if (out.length >= 120) break;
  }
  return out;
}

function refuse(
  error: BodyErrorCode,
  detail: string | undefined,
  log: Warn | undefined,
  route: string,
  fields?: Record<string, string | number | boolean | null>,
): BodyRefusal {
  log?.warn(`${route}.body_${error}`, {
    ...(detail !== undefined ? { detail } : {}),
    ...fields,
  });
  return {
    success: false,
    error,
    status: REFUSAL_STATUS[error],
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Read and JSON-parse a request body, or refuse it with the documented code.
 * `route` names the log namespace (`chat`/`feedback`); `detail` is log-only —
 * routes answer the bare `{ error }` contract and never echo input bytes.
 */
export async function readJsonBody(req: Request, route: string, log?: Warn): Promise<BodyResult> {
  if (jsonMediaType(req.headers.get("content-type")) === null) {
    const header = req.headers.get("content-type");
    return refuse(
      "unsupported_media_type",
      "A JSON request body requires Content-Type: application/json.",
      log,
      route,
      { contentType: header === null ? "absent" : loggable(header) },
    );
  }
  const declared = declaredBytes(req);
  if (declared !== null && declared > BODY_MAX_BYTES) {
    return refuse(
      "payload_too_large",
      `The body declares ${declared} bytes; the ceiling is ${BODY_MAX_BYTES}.`,
      log,
      route,
      { declared, limit: BODY_MAX_BYTES },
    );
  }
  const read = await readAtMost(req, BODY_MAX_BYTES);
  if (read.kind === "too_large") {
    return refuse(
      "payload_too_large",
      `The body exceeds the ${BODY_MAX_BYTES}-byte ceiling.`,
      log,
      route,
      { limit: BODY_MAX_BYTES, read: read.bytes },
    );
  }
  if (read.kind === "unreadable") {
    log?.warn(`${route}.body_unreadable`);
    return { success: false, error: "invalid_json", status: REFUSAL_STATUS.invalid_json };
  }
  const text = decodeUtf8(read.bytes);
  if (text === null) {
    return refuse("invalid_encoding", "The body is not valid UTF-8.", log, route, {
      bytes: read.bytes.byteLength,
    });
  }
  try {
    return { success: true, value: JSON.parse(text) };
  } catch (err) {
    const detail = loggable(err instanceof Error ? err.message : "parse error");
    return refuse("invalid_json", detail, log, route);
  }
}
