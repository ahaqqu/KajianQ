import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  ChatCitationSchema,
  ChatCitationsFrameSchema,
  ChatSessionMessageSchema,
  ChatSessionMessagesSchema,
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
    expect(
      v.safeParse(ChatSessionMessagesSchema, { sessionId: "s1", messages: [] }).success,
    ).toBe(false);
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
