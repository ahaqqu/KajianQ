import { describe, expect, it } from "vite-plus/test";
import type { ChatSessionMessages } from "@app/contracts";
import { conversationFileName, conversationMarkdown } from "./chat-export";

const TRANSCRIPT: ChatSessionMessages = {
  sessionId: "s1",
  truncated: false,
  messages: [
    { id: "m1", role: "user", content: "Apa itu ayat kursi?", createdAt: 1 },
    {
      id: "m2",
      role: "assistant",
      content: "Ayat al-Kursi adalah ayat 255 surah al-Baqarah.",
      createdAt: 2,
      citations: {
        messageId: "m2",
        refusal: false,
        dhaifWarning: false,
        citations: [
          {
            label: "QS. 2:255",
            arabic: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
            translation: "Allah, tidak ada tuhan selain Dia.",
            machineTranslated: false,
            source: "Al-Baqarah 255",
          },
        ],
      },
    },
  ],
};

describe("conversationMarkdown", () => {
  it("writes the title, each turn, and an answer's cited sources", () => {
    const md = conversationMarkdown(TRANSCRIPT, "id", "Apa itu ayat kursi?");
    expect(md.startsWith("# Apa itu ayat kursi?\n")).toBe(true);
    expect(md).toContain("## Anda\n\nApa itu ayat kursi?");
    expect(md).toContain("## KajianQ\n\nAyat al-Kursi adalah ayat 255 surah al-Baqarah.");
    expect(md).toContain("- QS. 2:255 — Al-Baqarah 255");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("follows the conversation's locale, not the reader's current one", () => {
    expect(conversationMarkdown(TRANSCRIPT, "en", "Apa itu ayat kursi?")).toContain("## You");
  });

  it("names an untitled conversation and marks a truncated one", () => {
    const md = conversationMarkdown({ ...TRANSCRIPT, truncated: true }, "id", "  ");
    expect(md.startsWith("# Percakapan tanpa judul")).toBe(true);
    expect(md).toContain("Awal percakapan ini tidak disertakan.");
  });

  it("writes no source list for an answer that cites nothing", () => {
    const md = conversationMarkdown(
      { ...TRANSCRIPT, messages: [TRANSCRIPT.messages[0]!] },
      "id",
      "Apa itu ayat kursi?",
    );
    expect(md).not.toContain("- QS.");
    expect(md.trimEnd().endsWith("Apa itu ayat kursi?")).toBe(true);
  });

  it("writes every chain row with its grade, grader and sanad — never the flat grade", () => {
    // The downloaded copy is one of the paths that render a citation grade. A
    // sahih+dhaif citation must keep both rows, exactly as the sheet does; the
    // passage's flattened `grade` is not the verdict of either chain.
    const transcript: ChatSessionMessages = {
      ...TRANSCRIPT,
      messages: [
        TRANSCRIPT.messages[0]!,
        {
          ...TRANSCRIPT.messages[1]!,
          citations: {
            messageId: "m2",
            refusal: false,
            dhaifWarning: false,
            citations: [
              {
                label: "HR. Bukhari no. 1",
                arabic: "حدثنا",
                grade: "sahih",
                machineTranslated: false,
                chains: [
                  {
                    narrators: [
                      { id: "n1", nameAr: "نافع" },
                      { id: "n2", nameAr: "ابن عمر" },
                    ],
                    grade: "sahih",
                    grader: "al-bukhari",
                  },
                  {
                    narrators: [{ id: "n1", nameAr: "نافع" }],
                    grade: "dhaif",
                    grader: "al-daraqutni",
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const md = conversationMarkdown(transcript, "id", "Hadits");
    expect(md).toContain(
      "- HR. Bukhari no. 1 — (sahih — al-bukhari; Jalur periwayatan: نافع < ابن عمر) (dhaif — al-daraqutni; Jalur periwayatan: نافع)",
    );
    expect(md).not.toContain("(sahih)");
  });

  it("writes the unread marker for a passage whose chains were not read", () => {
    const transcript: ChatSessionMessages = {
      ...TRANSCRIPT,
      messages: [
        TRANSCRIPT.messages[0]!,
        {
          ...TRANSCRIPT.messages[1]!,
          citations: {
            messageId: "m2",
            refusal: false,
            dhaifWarning: false,
            citations: [
              {
                label: "HR. Bukhari no. 1",
                arabic: "حدثنا",
                grade: "sahih",
                machineTranslated: false,
                chainsUnread: true,
              },
            ],
          },
        },
      ],
    };
    const md = conversationMarkdown(transcript, "id", "Hadits");
    expect(md).toContain("- HR. Bukhari no. 1 — (sanad tidak dibaca)");
    expect(md).not.toContain("(sahih)");
  });
});

describe("conversationFileName", () => {
  it("slugifies the first question and dates the file", () => {
    const name = conversationFileName("Apa itu ayat kursi?", Date.UTC(2026, 9, 26));
    expect(name).toBe("kajianq-apa-itu-ayat-kursi-2026-10-26.md");
  });

  it("falls back to a generic name when the title has no usable characters", () => {
    expect(conversationFileName("???", Date.UTC(2026, 9, 26))).toBe(
      "kajianq-percakapan-2026-10-26.md",
    );
  });
});
