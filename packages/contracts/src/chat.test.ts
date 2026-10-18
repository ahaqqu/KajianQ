import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  STORABLE_TEXT_PATTERN,
  ChatCitationSchema,
  ChatCitationsFrameSchema,
  ChatMetaSchema,
  ChatRequestSchema,
  ChatSessionMessageSchema,
  ChatSessionMessagesSchema,
  ChatTraceChunkSchema,
  ChatTraceFrameSchema,
  isChatSessionId,
  isStorableText,
} from "./chat";

/**
 * Contracts for the structured citation payload and the session-rehydration
 * response: the trap cases matter more than the happy path, because a malformed
 * payload renders an affordance with nothing behind it or lets the UI guess.
 */

const CITATION = {
  label: "QS. 2:255",
  arabic: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
  translation: "Allah, tidak ada tuhan selain Dia.",
  machineTranslated: true,
  source: "Al-Baqarah",
};

/**
 * The chat request's message ceiling: the contract is the only bound on the
 * router/generator/reviewer spend a question triggers — the rate limiter meters
 * frequency, never size (ADR-0041).
 */
describe("ChatRequestSchema message ceiling (#256)", () => {
  const parseMessage = (length: number) =>
    v.safeParse(ChatRequestSchema, { message: "a".repeat(length) }).success;

  it("pins the owner-decided ceiling at 2,000 characters", () => {
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

  // Validation never trims, so the bound applies to the raw body.
  it("measures the raw string: a body that would only trim to the ceiling is rejected", () => {
    expect(
      v.safeParse(ChatRequestSchema, { message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH) + " " })
        .success,
    ).toBe(false);
  });

  it("accepts a whitespace-only body inside the ceiling (pre-existing minLength(1) decides)", () => {
    // A direct API client can send one, and it runs the pipeline — bounded by
    // the ceiling, never by a hidden normalization the client cannot see.
    expect(v.safeParse(ChatRequestSchema, { message: " " }).success).toBe(true);
    expect(
      v.safeParse(ChatRequestSchema, { message: " ".repeat(CHAT_MESSAGE_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      v.safeParse(ChatRequestSchema, { message: " ".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

/**
 * The message field's storability rule: the message is written to a Postgres
 * `text` column, and `text` is stored in the database encoding — so the
 * contract, never the store and never the route, refuses the payloads no
 * `text` value can hold. Both are legal JSON and pass every other check:
 * U+0000, which no `text` value may carry, and an unpaired surrogate, which
 * UTF-8 cannot encode (a write stores U+FFFD — a different message than the
 * client sent).
 *
 * The same rule splits the `Cc` class on storability, not on "is a control": a
 * control the store CAN hold stays a body the contract admits and the
 * content-free admission declines, so no control character becomes a rejected
 * request by accident.
 */
describe("ChatRequestSchema message storability (#478)", () => {
  const accepts = (message: unknown) => v.safeParse(ChatRequestSchema, { message }).success;

  it("rejects the staging probes: a bare U+0000 and a U+0000-prefixed message", () => {
    expect(accepts("\u0000")).toBe(false);
    expect(accepts("\u0000riba")).toBe(false);
  });

  it("rejects U+0000 anywhere in the message, not only at its head", () => {
    expect(accepts("riba\u0000")).toBe(false);
    expect(accepts("a\u0000b")).toBe(false);
  });

  it("rejects a lone high surrogate alone, mid-string, and at the end", () => {
    expect(accepts("\ud800")).toBe(false);
    expect(accepts("ri\ud800ba")).toBe(false);
    expect(accepts("riba\ud800")).toBe(false);
  });

  it("rejects a lone low surrogate (the half a mis-sliced client body sends)", () => {
    expect(accepts("\udc00")).toBe(false);
    expect(accepts("riba\udc00")).toBe(false);
  });

  it("still accepts a well-formed surrogate pair (an emoji is a message)", () => {
    expect(accepts("😀")).toBe(true);
    expect(accepts("\ud83d\ude00")).toBe(true);
    expect(accepts("riba 😀")).toBe(true);
  });

  it("still accepts the control characters the store can hold", () => {
    // `Cc` outside U+0000, `Cf` zero-width characters, whitespace, punctuation:
    // storability is the line, and none of these crosses it.
    for (const text of [
      "\u0001\u0007",
      "\u0007",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u200b",
      "\ufeff",
      "\u00ad",
      "   ",
      "؟!؟",
    ]) {
      expect(accepts(text)).toBe(true);
    }
  });

  it("keeps the floor and the ceiling on the same field", () => {
    expect(accepts("")).toBe(false);
    expect(accepts("a".repeat(CHAT_MESSAGE_MAX_LENGTH))).toBe(true);
    expect(accepts("a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1))).toBe(false);
  });

  it("carries the storability half of the message verdict, never the length bounds", () => {
    // One storability rule, two readers: the field schema is the boundary and
    // `isStorableText` is what a caller outside the parse can ask. They agree on
    // every storability decision and disagree on length, which is the schema's
    // half alone — so a caller reaching for the predicate applies the bounds
    // itself.
    for (const text of ["\u0000", "\ud800", "riba", "😀", "\u0001\u0007"]) {
      expect(isStorableText(text)).toBe(accepts(text));
    }
    expect(isStorableText("")).toBe(true);
    expect(accepts("")).toBe(false);
    expect(isStorableText("a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1))).toBe(true);
    expect(accepts("a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1))).toBe(false);
  });

  /**
   * Raw UTF-16 code units, so unpaired surrogates and U+0000 are in the input
   * space rather than a hand-picked list.
   */
  const codeUnitsArb = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 24 })
    .map((units) => String.fromCharCode(...units));

  /** Texts straddling the ceiling from both sides. */
  const lengthArb = fc
    .integer({ min: CHAT_MESSAGE_MAX_LENGTH - 5, max: CHAT_MESSAGE_MAX_LENGTH + 5 })
    .map((length) => "a".repeat(length));

  /**
   * The law, against an oracle that reads the store rather than the check: a
   * message is admissible exactly when it is within the ceiling, its UTF-8
   * bytes carry no 0x00, and those bytes decode back to the same text — which is
   * what "the store can hold it" means, since `text` is stored in the database
   * encoding. A check that misses an unrepresentable class disagrees with the
   * bytes and reddens here.
   */
  fcTest.prop([fc.oneof(codeUnitsArb, lengthArb)])(
    "admits exactly the texts whose UTF-8 bytes are NUL-free and decode back unchanged",
    (text) => {
      const encoded = new TextEncoder().encode(text);
      const storable =
        text.length >= 1 &&
        text.length <= CHAT_MESSAGE_MAX_LENGTH &&
        !encoded.includes(0) &&
        new TextDecoder().decode(encoded) === text;
      expect(v.safeParse(ChatRequestSchema, { message: text }).success).toBe(storable);
    },
  );

  it("draws both verdicts, so the law above is not vacuous", () => {
    // A fixed seed: the assertion is about the generator's reach, and a random
    // sample would make it a flake instead.
    const sample = fc.sample(codeUnitsArb, { numRuns: 500, seed: 0x478 });
    expect(sample.some((text) => accepts(text))).toBe(true);
    expect(sample.some((text) => !accepts(text))).toBe(true);
    expect(sample.some((text) => new TextEncoder().encode(text).includes(0))).toBe(true);
    expect(sample.some((text) => !isStorableText(text))).toBe(true);
  });
});

/**
 * The published pattern and the runtime predicate are one rule: JSON Schema has
 * no form for a custom check, so the rule is written as the `pattern` the
 * emitter publishes. This differential is what licenses that form — it pins the
 * pattern to an explicit per-code-unit reading of the same rule over the whole
 * input space, so the two readers cannot drift apart.
 */
describe("the message storability pattern decides what the code-unit scan decides (#535)", () => {
  /**
   * The rule read explicitly, one code unit at a time, independent of the regex
   * engine: U+0000 refused anywhere, a high surrogate admitted only as the lead
   * of a low one, a low surrogate never on its own.
   */
  const scansAsStorable = (text: string): boolean => {
    if (text.includes("\u0000")) return false;
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
        i += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return false;
      }
    }
    return true;
  };

  const published = () => new RegExp(STORABLE_TEXT_PATTERN);

  it("agrees on every UTF-16 code unit as a one-unit string", () => {
    const pattern = published();
    const mismatches: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const text = String.fromCharCode(unit);
      if (pattern.test(text) !== scansAsStorable(text)) {
        mismatches.push(`U+${unit.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees on every Unicode code point, astral characters included", () => {
    // The whole scalar range, plus the surrogate block that `fromCodePoint`
    // still emits as a lone unit: every astral character is a well-formed pair,
    // which is what exercises the pattern's pair alternative.
    const pattern = published();
    const mismatches: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      const text = String.fromCodePoint(point);
      if (pattern.test(text) !== scansAsStorable(text)) {
        mismatches.push(`U+${point.toString(16).toUpperCase()}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * Raw UTF-16 code units, drawn heavily from the surrogate block and U+0000 so
   * that lone surrogates land mid-string and at either end; astral strings add
   * the valid-pair and astral-character half of the space.
   */
  const unitStrings = fc
    .array(
      fc.oneof(
        { weight: 4, arbitrary: fc.integer({ min: 0xd800, max: 0xdfff }) },
        {
          weight: 2,
          arbitrary: fc.constantFrom(0x0000, 0x0001, 0x007f, 0x00cc, 0xfeff, 0xffff),
        },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 0xffff }) },
      ),
      { maxLength: 24 },
    )
    .map((units) => String.fromCharCode(...units));

  const astralStrings = fc
    .array(fc.integer({ min: 0x10000, max: 0x10ffff }), { maxLength: 8 })
    .map((points) => String.fromCodePoint(...points));

  /** Lone surrogates pinned at both ends, so no draw can miss the edge cases. */
  const wrappedSurrogates = fc
    .tuple(
      fc.integer({ min: 0xd800, max: 0xdfff }),
      fc.string({ maxLength: 12 }),
      fc.integer({ min: 0xd800, max: 0xdfff }),
    )
    .map(([lead, middle, tail]) => String.fromCharCode(lead) + middle + String.fromCharCode(tail));

  const textArb = fc.oneof(unitStrings, astralStrings, wrappedSurrogates);

  fcTest.prop([textArb])("the pattern and the scan agree on every generated string", (text) => {
    expect(published().test(text), JSON.stringify(text)).toBe(scansAsStorable(text));
  });

  it("draws both verdicts from each generator, so the differential is not vacuous", () => {
    const sample = fc.sample(textArb, { numRuns: 500, seed: 0x535 });
    expect(sample.some((text) => scansAsStorable(text))).toBe(true);
    expect(sample.some((text) => !scansAsStorable(text))).toBe(true);
  });
});

/**
 * The chat session id as a REQUEST value: the store's `chat_sessions.id` is a
 * `uuid`, so a non-UUID `sessionId` must be refused at the boundary, before the
 * adapter's cast — the two server-produced `sessionId` members deliberately
 * stay opaque.
 */
describe("ChatRequestSchema sessionId (#271)", () => {
  const sessionIdOf = (sessionId: unknown) =>
    v.safeParse(ChatRequestSchema, { message: "Apa maksud Ayat Kursi?", sessionId }).success;

  it("accepts a well-formed UUID", () => {
    expect(sessionIdOf(crypto.randomUUID())).toBe(true);
  });

  /**
   * Case-insensitivity is part of the accepted contract: valibot's `uuid()`
   * carries the `i` flag and the `chat_sessions.id` column behind it is
   * case-insensitive too, so a client that re-cases what it persisted still
   * holds a value the store can address — a lowercase-only tightening would
   * refuse a valid id at the boundary.
   */
  it("admits an UPPERCASE canonical-shaped id on both request surfaces (#312)", () => {
    expect(sessionIdOf("7B1A712F-3990-46CE-9964-4EB344A867C5")).toBe(true);
    // The rehydration route's path guard reads the same schema.
    expect(isChatSessionId("7B1A712F-3990-46CE-9964-4EB344A867C5")).toBe(true);
  });

  it("admits a MIXED-case canonical-shaped id (#312)", () => {
    expect(sessionIdOf("7b1A712F-3990-46ce-9964-4EB344A867C5")).toBe(true);
  });

  it("accepts an absent sessionId (a new session is the default)", () => {
    expect(v.safeParse(ChatRequestSchema, { message: "hi" }).success).toBe(true);
  });

  it("rejects the staging probe's non-UUID value", () => {
    expect(sessionIdOf("en")).toBe(false);
  });

  it("rejects a UUID-shaped value that is not one", () => {
    // A client that truncates or over-pads an id must be refused at the
    // boundary, not by the store's cast later.
    expect(sessionIdOf("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1")).toBe(false);
    expect(sessionIdOf("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11x")).toBe(false);
    expect(sessionIdOf("not-a-uuid-at-all-but-long-enough")).toBe(false);
  });

  /**
   * The Postgres-legal extra-hyphen spelling stays refused: PostgreSQL accepts a
   * hyphen after any group of four digits, so the `uuid` column would take it —
   * the schema is the stricter of the two and refuses it first, which is the only
   * reason the memory stand-in's own, even-tighter rule for the same spelling
   * (`uuidShaped` in
   * `packages/kajianq-domain/src/test-utils/memory-rag-store-chat.ts`) is inert.
   * Both halves are pinned: the stand-in's verdict in that package's
   * `memory-rag-store-chat.test.ts`, the boundary refusal here.
   */
  it("rejects the Postgres-legal extra-hyphen spelling on both surfaces (#312)", () => {
    expect(sessionIdOf("7b1a-712f-3990-46ce-9964-4eb344a867c5")).toBe(false);
    expect(isChatSessionId("7b1a-712f-3990-46ce-9964-4eb344a867c5")).toBe(false);
  });

  it("rejects an empty sessionId (the pre-existing floor holds)", () => {
    expect(sessionIdOf("")).toBe(false);
  });

  it("exposes the same rule as the predicate the path-param guard uses", () => {
    // The rehydration route validates a path param, not a body; it reads this
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
   * The response schemas keep the opaque `minLength(1)` form: the `RagStore`
   * seam types chat session ids as `string`, and a UUID claim on a value the
   * store produced would over-constrain every adapter while preventing no 500.
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

  it("accepts a refusal frame that keeps its citations (a hybrid answer, #436)", () => {
    // The two fields are independent: the refusal flag reports the decision and
    // never empties the list, so a refusal over a partly-cited answer is valid.
    const parsed = v.parse(ChatCitationsFrameSchema, {
      messageId: "m3",
      citations: [CITATION],
      refusal: true,
      dhaifWarning: true,
    });
    expect(parsed.refusal).toBe(true);
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.dhaifWarning).toBe(true);
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
    // A frame whose chunks carry no origin label must still parse: the field is
    // additive and optional.
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
