import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatCitationSchema,
  ChatCitationsFrameSchema,
  ChatMetaSchema,
  ChatRequestSchema,
  ChatSessionMessageSchema,
  ChatSessionMessagesSchema,
  ChatTraceChunkSchema,
  ChatTraceFrameSchema,
  isChatSessionId,
} from "./chat";

/**
 * Contracts for the structured citation payload and the session-rehydration
 * response (#11, ADR-0040). The trap cases matter more than the happy path:
 * an empty label or an empty `arabic` would render a citation affordance with
 * nothing behind it, and a non-boolean refusal flag would let the UI guess.
 */

const CITATION = {
  label: "QS. 2:255",
  arabic: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
  translation: "Allah, tidak ada tuhan selain Dia.",
  machineTranslated: true,
  source: "Al-Baqarah",
};

/**
 * The chat request's message ceiling (#256). The boundary cases are the point:
 * a message AT the ceiling must parse (a pasted passage plus a question is a
 * legitimate question), one character over must not — the contract is the only
 * bound between a client and the router/generator/reviewer spend a question
 * triggers (ADR-0041 meters frequency, never size).
 */
describe("ChatRequestSchema message ceiling (#256)", () => {
  const parseMessage = (length: number) =>
    v.safeParse(ChatRequestSchema, { message: "a".repeat(length) }).success;

  it("pins the owner-decided ceiling at 2,000 characters", () => {
    // The value is an owner decision (issue #256): lowering or raising it is a
    // deliberate edit here and in the schema, never a silent drift.
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(2000);
  });

  it("accepts a message one character under the ceiling and one exactly at it", () => {
    expect(parseMessage(CHAT_MESSAGE_MAX_LENGTH - 1)).toBe(true);
    expect(parseMessage(CHAT_MESSAGE_MAX_LENGTH)).toBe(true);
  });

  it("rejects a message one character over the ceiling", () => {
    expect(parseMessage(CHAT_MESSAGE_MAX_LENGTH + 1)).toBe(false);
  });

  it("rejects the 20,000-character probe that opened the QA finding", () => {
    expect(parseMessage(20_000)).toBe(false);
  });

  it("keeps the empty-message floor (minLength still rejects a blank question)", () => {
    expect(parseMessage(0)).toBe(false);
  });

  /**
   * The trim/length semantics are surprising enough to be decisions, not
   * accidents (thermo-review C1): validation never trims, so the bound applies
   * to the raw body. Both halves are pinned here so a future "helpful" trim
   * cannot land silently in either direction.
   */
  it("measures the raw string: a body that would only trim to the ceiling is rejected", () => {
    expect(
      v.safeParse(ChatRequestSchema, { message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH) + " " })
        .success,
    ).toBe(false);
  });

  it("accepts a whitespace-only body inside the ceiling (pre-existing minLength(1) decides)", () => {
    // The composer trims before sending, so the UI cannot build one; a direct
    // API client can, and it runs the pipeline — bounded by the ceiling, never
    // by a hidden normalization the client cannot see.
    expect(v.safeParse(ChatRequestSchema, { message: " " }).success).toBe(true);
    expect(
      v.safeParse(ChatRequestSchema, { message: " ".repeat(CHAT_MESSAGE_MAX_LENGTH) }).success,
    ).toBe(true);
    // …and the ceiling still bounds it: one more whitespace unit is over.
    expect(
      v.safeParse(ChatRequestSchema, { message: " ".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

/**
 * The chat session id as a REQUEST value (#271): the store's `chat_sessions.id`
 * is a `uuid`, so a non-UUID `sessionId` used to pass validation and die in the
 * adapter's cast as a 500. The contract is the boundary — these rows pin that a
 * malformed id is refused HERE, that the ceiling (#256) is untouched, and that
 * the two server-produced `sessionId` members deliberately stay opaque.
 */
describe("ChatRequestSchema sessionId (#271)", () => {
  const sessionIdOf = (sessionId: unknown) =>
    v.safeParse(ChatRequestSchema, { message: "Apa maksud Ayat Kursi?", sessionId }).success;

  it("accepts a well-formed UUID", () => {
    expect(sessionIdOf(crypto.randomUUID())).toBe(true);
  });

  it("accepts an absent sessionId (a new session is the default)", () => {
    expect(v.safeParse(ChatRequestSchema, { message: "hi" }).success).toBe(true);
  });

  it("rejects the staging probe's non-UUID value", () => {
    expect(sessionIdOf("en")).toBe(false);
  });

  it("rejects a UUID-shaped value that is not one", () => {
    // The near-misses matter more than an obviously wrong string: a client
    // that truncates or over-pads an id must be refused at the boundary, not
    // by the store's cast later.
    expect(sessionIdOf("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1")).toBe(false);
    expect(sessionIdOf("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11x")).toBe(false);
    expect(sessionIdOf("not-a-uuid-at-all-but-long-enough")).toBe(false);
  });

  it("rejects an empty sessionId (the pre-existing floor holds)", () => {
    expect(sessionIdOf("")).toBe(false);
  });

  it("exposes the same rule as the predicate the path-param guard uses", () => {
    // The rehydration route validates a path param, not a body. It reads this
    // predicate, so the two request surfaces cannot drift into two rules.
    expect(isChatSessionId(crypto.randomUUID())).toBe(true);
    expect(isChatSessionId("en")).toBe(false);
    expect(isChatSessionId("")).toBe(false);
  });

  it("keeps the #256 message ceiling intact alongside the session-id rule", () => {
    const sessionId = crypto.randomUUID();
    expect(
      v.safeParse(ChatRequestSchema, {
        message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH),
        sessionId,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ChatRequestSchema, {
        message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1),
        sessionId,
      }).success,
    ).toBe(false);
  });

  /**
   * The per-field decision, pinned rather than left to prose: the response
   * schemas keep the opaque `minLength(1)` form. Their values come FROM the
   * store (`ChatMetaSchema` echoes a minted or already-validated id;
   * `ChatSessionMessagesSchema` echoes the route's own param), and the
   * `RagStore` seam types chat session ids as `string` — a UUID claim there
   * would over-constrain every adapter while preventing no 500.
   */
  it("leaves the server-produced sessionId members opaque", () => {
    expect(
      v.safeParse(ChatMetaSchema, {
        sessionId: "sess-legacy",
        messageId: "m1",
        traceId: "t1",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ChatSessionMessagesSchema, {
        sessionId: "sess-legacy",
        messages: [],
        truncated: false,
      }).success,
    ).toBe(true);
  });
});

describe("ChatCitationSchema", () => {
  it("accepts a fully populated citation", () => {
    const parsed = v.parse(ChatCitationSchema, {
      ...CITATION,
      grade: "graded",
    });
    expect(parsed.label).toBe("QS. 2:255");
    expect(parsed.grade).toBe("graded");
  });

  it("accepts a citation with no grade and no translation", () => {
    const parsed = v.parse(ChatCitationSchema, {
      label: "QS. 112:1",
      arabic: "قُلْ هُوَ اللَّهُ أَحَدٌ",
      machineTranslated: false,
    });
    expect(parsed.translation).toBeUndefined();
    expect(parsed.grade).toBeUndefined();
  });

  it("rejects an empty label or empty arabic (nothing to show behind a chip)", () => {
    expect(v.safeParse(ChatCitationSchema, { ...CITATION, label: "" }).success).toBe(false);
    expect(v.safeParse(ChatCitationSchema, { ...CITATION, arabic: "" }).success).toBe(false);
  });

  it("rejects a citation with no arabic original (ADR-0013: canonical evidence layer)", () => {
    const { arabic: _arabic, ...noArabic } = CITATION;
    expect(v.safeParse(ChatCitationSchema, noArabic).success).toBe(false);
  });

  it("rejects a non-boolean machineTranslated flag", () => {
    expect(v.safeParse(ChatCitationSchema, { ...CITATION, machineTranslated: "yes" }).success).toBe(
      false,
    );
  });
});

describe("ChatCitationsFrameSchema", () => {
  it("accepts the SSE frame with resolved citations", () => {
    const parsed = v.parse(ChatCitationsFrameSchema, {
      messageId: "m1",
      citations: [CITATION],
      refusal: false,
      dhaifWarning: false,
    });
    expect(parsed.citations).toHaveLength(1);
  });

  it("accepts a refusal frame with an empty citation list", () => {
    const parsed = v.parse(ChatCitationsFrameSchema, {
      messageId: "m2",
      citations: [],
      refusal: true,
      dhaifWarning: false,
    });
    expect(parsed.refusal).toBe(true);
    expect(parsed.citations).toEqual([]);
  });

  it("rejects a frame whose refusal flag is missing (the UI must not guess)", () => {
    const { refusal: _refusal, ...noFlag } = {
      messageId: "m1",
      citations: [],
      refusal: false,
      dhaifWarning: false,
    };
    expect(v.safeParse(ChatCitationsFrameSchema, noFlag).success).toBe(false);
  });
});

describe("ChatSessionMessagesSchema", () => {
  it("accepts a transcript with a cited assistant turn and a plain user turn", () => {
    const parsed = v.parse(ChatSessionMessagesSchema, {
      sessionId: "s1",
      truncated: false,
      messages: [
        { id: "m0", role: "user", content: "Apa itu ayat kursi?", createdAt: 1 },
        {
          id: "m1",
          role: "assistant",
          content: "Ayat kursi adalah [QS. 2:255].",
          citations: {
            messageId: "m1",
            citations: [CITATION],
            refusal: false,
            dhaifWarning: false,
          },
          createdAt: 2,
        },
      ],
    });
    expect(parsed.messages[0]?.citations).toBeUndefined();
    expect(parsed.messages[1]?.citations?.citations[0]?.label).toBe("QS. 2:255");
  });

  it("rejects a transcript whose truncated marker is missing (the tail must be visible, thermo-review A4)", () => {
    expect(v.safeParse(ChatSessionMessagesSchema, { sessionId: "s1", messages: [] }).success).toBe(
      false,
    );
  });

  it("rejects an unknown role (roles are the product's two transcript roles)", () => {
    expect(
      v.safeParse(ChatSessionMessageSchema, {
        id: "m1",
        role: "system",
        content: "x",
        createdAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ChatTraceFrameSchema", () => {
  const CHUNK = { id: "chunk-1", source: "Al-Baqarah", score: 0.03125 };

  const FRAME = {
    messageId: "m1",
    sources: [CHUNK],
    technical: {
      intent: "fiqh",
      confidence: 0.9,
      subQueries: ["ayat kursi", "QS 2:255 terjemahan"],
      chunks: [CHUNK],
      models: ["router-model", "generator-model"],
    },
  };

  it("accepts a fully populated trace frame (both layers)", () => {
    const parsed = v.parse(ChatTraceFrameSchema, FRAME);
    expect(parsed.sources[0]?.source).toBe("Al-Baqarah");
    expect(parsed.technical.intent).toBe("fiqh");
    expect(parsed.technical.models).toHaveLength(2);
  });

  it("accepts the top layer with the numeric fields absent (plain sources view)", () => {
    const parsed = v.parse(ChatTraceFrameSchema, {
      messageId: "m1",
      sources: [{ id: "chunk-1", source: "Al-Baqarah" }],
      technical: { subQueries: [], chunks: [], models: [] },
    });
    expect(parsed.sources[0]?.score).toBeUndefined();
    expect(parsed.technical.intent).toBeUndefined();
  });

  it("parses a frame persisted before `origin` existed (A1 backward compatibility)", () => {
    // The exact pre-ADR-0045 frame shape: no chunk carries an origin label.
    // It must still parse and render — the field is additive and optional.
    const parsed = v.parse(ChatTraceFrameSchema, FRAME);
    for (const chunk of [...parsed.sources, ...parsed.technical.chunks]) {
      expect(chunk.origin).toBeUndefined();
    }
  });

  it("carries an opacity-checked `origin` label on a chunk ref (ADR-0045)", () => {
    const chunk = { ...CHUNK, origin: "scope_expansion" };
    const parsed = v.parse(ChatTraceFrameSchema, {
      ...FRAME,
      sources: [chunk],
      technical: { ...FRAME.technical, chunks: [chunk] },
    });
    expect(parsed.technical.chunks[0]?.origin).toBe("scope_expansion");
    // An empty label is not a label: the panel must never render a blank reason.
    expect(v.safeParse(ChatTraceChunkSchema, { id: "c1", origin: "" }).success).toBe(false);
  });

  it("accepts a refusal's empty frame (no sources consulted, no machinery to show)", () => {
    const parsed = v.parse(ChatTraceFrameSchema, {
      messageId: "m2",
      sources: [],
      technical: { subQueries: [], chunks: [], models: ["router-model"] },
    });
    expect(parsed.sources).toEqual([]);
  });

  it("rejects a missing technical layer (the deeper view is part of the frame)", () => {
    const { technical: _technical, ...noTech } = FRAME;
    expect(v.safeParse(ChatTraceFrameSchema, noTech).success).toBe(false);
  });

  it("rejects a chunk with an empty id (provenance must be resolvable)", () => {
    expect(v.safeParse(ChatTraceFrameSchema, { ...FRAME, sources: [{ id: "" }] }).success).toBe(
      false,
    );
  });

  it("accepts a session message carrying the optional trace frame, and a user turn without one", () => {
    const parsed = v.parse(ChatSessionMessagesSchema, {
      sessionId: "s1",
      truncated: false,
      messages: [
        { id: "m0", role: "user", content: "q", createdAt: 1 },
        { id: "m1", role: "assistant", content: "a", trace: FRAME, createdAt: 2 },
      ],
    });
    expect(parsed.messages[0]?.trace).toBeUndefined();
    expect(parsed.messages[1]?.trace?.technical.intent).toBe("fiqh");
  });
});
