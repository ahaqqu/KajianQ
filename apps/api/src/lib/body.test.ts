import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatRequestSchema,
  FEEDBACK_ANCHOR_STRING_MAX_LENGTH,
  FEEDBACK_FREE_TEXT_MAX_LENGTH,
  FeedbackRequestSchema,
} from "@app/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import {
  BODY_MAX_BYTES,
  LOG_DETAIL_MAX_LENGTH,
  REJECTION_STATUS,
  readJsonBody,
  reject,
  type BodyRejectionCode,
  type Warn,
} from "./body";

/**
 * The boundary invariant: a JSON request body is either decoded losslessly and
 * handed to the route's schema, or rejected with the documented code/status —
 * never replacement-decoded into a different string, never silently truncated,
 * and never a 500.
 *
 * Adversarial cases named up front: invalid UTF-8 (lone continuation, truncated
 * sequence, overlong pair, CESU-8 surrogate), raw C0 controls (which strict JSON
 * forbids), a body over the ceiling with and without a Content-Length, a lying
 * Content-Length, a media type that is not JSON, and an unreadable stream.
 */

type Captured = { msg: string; fields?: Record<string, string | number | boolean | null> };

function capture(): { entries: Captured[]; log: Warn } {
  const entries: Captured[] = [];
  return {
    entries,
    log: {
      warn: (msg, fields) => entries.push(fields === undefined ? { msg } : { msg, fields }),
    },
  };
}

function request(
  body: BodyInit | Uint8Array | null,
  contentType: string | null = "application/json",
): Request {
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body: body as BodyInit | null,
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request("http://localhost/v1/chat", init);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

type ParseableSchema = Parameters<typeof v.safeParse>[0];

/**
 * The ceiling must stay at least this many times above the escaped worst-case
 * body the route accepts. This is the headroom the test asserts; the caps
 * themselves are what make the body the worst case.
 */
const WORST_CASE_HEADROOM_FACTOR = 2;

/**
 * Prove a payload is the worst-case legal body and that the reader whose
 * ceiling this pins accepts it.
 *
 * The payload parses against the route's schema, survives the `\uXXXX` escape
 * round-trip unchanged, and is then handed to `readJsonBody` as the exact wire
 * bytes — so the comparison is against the boundary the routes use, not an
 * arithmetic proxy.
 */
async function expectWorstCaseBodyAccepted(
  schema: ParseableSchema,
  payload: unknown,
  route: "chat" | "feedback",
): Promise<void> {
  expect(v.safeParse(schema, payload).success).toBe(true);
  const wire = JSON.stringify(payload).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  expect(JSON.parse(wire)).toEqual(payload);
  expect(v.safeParse(schema, JSON.parse(wire)).success).toBe(true);
  const read = await readJsonBody(request(wire), route);
  expect(read.success).toBe(true);
  const bodyBytes = new TextEncoder().encode(wire).byteLength;
  expect(BODY_MAX_BYTES).toBeGreaterThan(bodyBytes);
  expect(BODY_MAX_BYTES).toBeGreaterThanOrEqual(WORST_CASE_HEADROOM_FACTOR * bodyBytes);
}

describe("readJsonBody — media type", () => {
  it("accepts application/json, with or without parameters", async () => {
    for (const contentType of ["application/json", "Application/JSON; charset=utf-8"]) {
      const result = await readJsonBody(
        request('{"message":"hi"}', contentType),
        "chat",
        capture().log,
      );
      expect(result.success, contentType).toBe(true);
      if (result.success) expect(result.value).toEqual({ message: "hi" });
    }
  });

  it("accepts a structured JSON suffix media type", async () => {
    const result = await readJsonBody(
      request('{"message":"hi"}', "application/vnd.kajianq+json"),
      "chat",
    );
    expect(result.success).toBe(true);
  });

  it("rejects a structured suffix with an empty subtype", async () => {
    // RFC 6839's suffix needs a registered (hence non-empty) subtype: a media
    // type with nothing before `+json` is not JSON, whatever the ends match.
    for (const contentType of ["application/+json", "application/ +json"]) {
      const result = await readJsonBody(request('{"message":"hi"}', contentType), "chat");
      expect(result, contentType).toMatchObject({
        success: false,
        error: "unsupported_media_type",
        status: 415,
      });
    }
  });

  it("rejects a missing Content-Type with 415, before reading the body", async () => {
    const { entries, log } = capture();
    const result = await readJsonBody(request('{"message":"hi"}', null), "chat", log);
    expect(result).toMatchObject({
      success: false,
      error: "unsupported_media_type",
      status: 415,
    });
    expect(entries.map((entry) => entry.msg)).toContain("chat.body_unsupported_media_type");
  });

  it("rejects a non-JSON Content-Type with 415 and names the type in the log", async () => {
    const { entries, log } = capture();
    const result = await readJsonBody(
      request('{"message":"hi"}', "application/x-www-form-urlencoded"),
      "chat",
      log,
    );
    expect(result).toMatchObject({ success: false, error: "unsupported_media_type", status: 415 });
    expect(entries[0]?.fields?.["contentType"]).toBe("application/x-www-form-urlencoded");
  });
});

describe("readJsonBody — encoding", () => {
  it("decodes valid UTF-8, astral characters included", async () => {
    const result = await readJsonBody(request(textBytes('{"message":"😀؟"}')), "chat");
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toEqual({ message: "😀؟" });
  });

  it("rejects invalid UTF-8 with 400 invalid_encoding instead of replacement-decoding it", async () => {
    const bodies: [string, Uint8Array][] = [
      // A lone continuation byte — what a client sending the C1 control U+0093
      // as a raw byte produces; `Request.text()` would silently turn it into U+FFFD.
      ["lone continuation", bytes(0x7b, 0x22, 0x93, 0x22, 0x7d)],
      // A truncated three-byte sequence at the end of the body.
      ["truncated", bytes(0x22, 0xe2, 0x82)],
      // An overlong encoding of "/" (0xC0 0xAF): accepted by lenient decoders.
      ["overlong", bytes(0x22, 0xc0, 0xaf, 0x22)],
      // CESU-8 lone surrogate (ED A0 80): not UTF-8, but the shape that would
      // otherwise become U+FFFD and change the user's message.
      ["cesu-8 surrogate", bytes(0x22, 0xed, 0xa0, 0x80, 0x22)],
    ];
    for (const [name, body] of bodies) {
      const { entries, log } = capture();
      const result = await readJsonBody(request(body), "chat", log);
      expect(result, name).toMatchObject({
        success: false,
        error: "invalid_encoding",
        status: 400,
      });
      expect(
        entries.map((entry) => entry.msg),
        name,
      ).toContain("chat.body_invalid_encoding");
    }
  });
});

describe("readJsonBody — JSON syntax", () => {
  it("rejects raw NUL and control padding with 400 invalid_json", async () => {
    for (const pad of [0x00, 0x01, 0x1f]) {
      const result = await readJsonBody(
        request(bytes(0x7b, 0x22, 0x6d, 0x22, 0x3a, 0x22, 0x61, pad, 0x22, 0x7d)),
        "chat",
      );
      expect(result).toMatchObject({ success: false, error: "invalid_json", status: 400 });
    }
  });

  it("escapes control characters out of the logged parse detail", async () => {
    const { entries, log } = capture();
    const result = await readJsonBody(request(bytes(0x01)), "chat", log);
    expect(result).toMatchObject({ success: false, error: "invalid_json" });
    const detail = String(entries[0]?.fields?.["detail"] ?? "");
    expect(detail).toContain("\\u0001");
    expect(detail).not.toContain("\u0001");
    expect(detail.length).toBeLessThanOrEqual(LOG_DETAIL_MAX_LENGTH);
  });

  it("rejects an empty body with 400 invalid_json", async () => {
    const result = await readJsonBody(request(new Uint8Array(0)), "chat");
    expect(result).toMatchObject({ success: false, error: "invalid_json", status: 400 });
  });

  it("rejects an unreadable stream with 400 invalid_json and a body_unreadable log", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    const { entries, log } = capture();
    const result = await readJsonBody(request(body), "chat", log);
    expect(result).toMatchObject({ success: false, error: "invalid_json", status: 400 });
    expect(entries.map((entry) => entry.msg)).toContain("chat.body_unreadable");
  });

  it("hands an escaped NUL to the schema rather than guessing at the boundary", async () => {
    // JSON-legal, schema-invalid: the contract (not the reader) owns this rule,
    // so the reader must pass the parsed value through.
    const result = await readJsonBody(request(textBytes('{"message":"a\\u0000b"}')), "chat");
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toEqual({ message: "a\u0000b" });
  });
});

describe("readJsonBody — size", () => {
  it("rejects a streamed body over the ceiling with 413, without buffering it all", async () => {
    const chunk = textBytes("a".repeat(16 * 1024));
    const result = await readJsonBody(
      request(streamOf([chunk, chunk, chunk, chunk, chunk])),
      "chat",
    );
    expect(result).toMatchObject({ success: false, error: "payload_too_large", status: 413 });
  });

  it("rejects on a declared Content-Length over the ceiling before looking at the bytes", async () => {
    // The bytes are invalid UTF-8 and invalid JSON, so only the header check can
    // produce the 413: a reader-first implementation would answer 400 instead.
    const req = request(bytes(0x93));
    req.headers.set("content-length", String(BODY_MAX_BYTES + 1));
    const result = await readJsonBody(req, "chat");
    expect(result).toMatchObject({ success: false, error: "payload_too_large", status: 413 });
  });

  it("accepts a body exactly at the ceiling", async () => {
    const prefix = '{"message":"';
    const suffix = '"}';
    const padding = " ".repeat(BODY_MAX_BYTES - prefix.length - suffix.length);
    const body = textBytes(`${prefix}${padding}${suffix}`);
    expect(body.byteLength).toBe(BODY_MAX_BYTES);
    const result = await readJsonBody(request(body), "chat");
    expect(result.success).toBe(true);
  });

  it("rejects one byte over the ceiling even when Content-Length lies", async () => {
    const prefix = '{"message":"';
    const suffix = '"}';
    const padding = " ".repeat(BODY_MAX_BYTES - prefix.length - suffix.length + 1);
    const body = textBytes(`${prefix}${padding}${suffix}`);
    const req = request(body);
    req.headers.set("content-length", "20");
    const result = await readJsonBody(req, "chat");
    expect(result).toMatchObject({ success: false, error: "payload_too_large", status: 413 });
  });
});

describe("readJsonBody — rejection contract", () => {
  it("maps every rejection to its documented status", async () => {
    const cases: [string, Request, number][] = [
      ["no media type", request("{}", null), 415],
      ["bad media type", request("{}", "text/plain"), 415],
      ["bad encoding", request(bytes(0x93)), 400],
      ["bad json", request("nope"), 400],
      ["too large", request("x".repeat(BODY_MAX_BYTES + 1)), 413],
    ];
    for (const [name, req, status] of cases) {
      const result = await readJsonBody(req, "chat");
      expect(result.success, name).toBe(false);
      if (!result.success) expect(result.status, name).toBe(status);
    }
  });

  it("assigns every code its status through the one map", () => {
    // The constructor is the only place a status is assigned, so a code added
    // to the map without a status — or a caller mapping a 400 by hand — is the
    // drift this row catches, for the reader's codes and the schema's alike.
    for (const code of Object.keys(REJECTION_STATUS) as BodyRejectionCode[]) {
      expect(reject(code).status, code).toBe(REJECTION_STATUS[code]);
    }
    expect(REJECTION_STATUS.invalid_request).toBe(400);
  });

  it("keeps the ceiling above the worst-case legal chat body", async () => {
    // 2,000 UTF-16 code units of astral text, every surrogate escaped as
    // \uXXXX, plus the envelope — the widest body the chat schema admits.
    const legal = {
      message: "😀".repeat(CHAT_MESSAGE_MAX_LENGTH / 2),
      sessionId: "00000000-0000-4000-8000-000000000000",
      language: "id",
    };
    await expectWorstCaseBodyAccepted(ChatRequestSchema, legal, "chat");
  });

  it("keeps the ceiling above the worst-case legal feedback body", async () => {
    // A chain flag is the widest valid shape: free text at its own code-point
    // cap plus three anchored strings at the shared anchor cap. Every allowed
    // code point is an astral character escaped as two \uXXXX sequences, and
    // the payload is schema-valid, so the fuzz can generate exactly it.
    const astral = (codePoints: number) => "😀".repeat(codePoints);
    const legal = {
      messageId: "00000000-0000-4000-8000-000000000000",
      anchor: {
        type: "chain",
        category: "questionable_grade",
        id: astral(FEEDBACK_ANCHOR_STRING_MAX_LENGTH),
        chainIndex: 0,
        grade: astral(FEEDBACK_ANCHOR_STRING_MAX_LENGTH),
        grader: astral(FEEDBACK_ANCHOR_STRING_MAX_LENGTH),
      },
      freeText: astral(FEEDBACK_FREE_TEXT_MAX_LENGTH),
    };
    await expectWorstCaseBodyAccepted(FeedbackRequestSchema, legal, "feedback");
  });
});
