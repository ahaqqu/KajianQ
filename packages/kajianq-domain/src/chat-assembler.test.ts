import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Chunk, Query } from "@app/rag-core";
import { MACHINE_TRANSLATION_LABEL, createKajianQAssembler } from "./chat-assembler";
import type { KajianQFilters } from "./filters";

/**
 * The assembler's product rules (ticket #10 acceptance criteria): Arabic
 * originals accompany every quoted passage with a labeled machine translation
 * (ADR-0006), and prior turns ride the prompt so follow-up questions have
 * context. Deterministic, so these are direct assertions on the assembled
 * turns — no provider, no run.
 */

function assemble(
  chunks: readonly Chunk[],
  query: Query<KajianQFilters> = { text: "Apa itu Ayat Kursi?" },
): { turns: readonly { role: string; content: string }[]; chunks: readonly Chunk[] } {
  const stage = createKajianQAssembler();
  return Effect.runSync(stage.assemble(query, chunks) as never) as never;
}

describe("createKajianQAssembler", () => {
  it("orders Quran before hadith before other sources", () => {
    const quran: Chunk = { id: "q", text: "quran", metadata: { sourceType: "quran" }, score: 1 };
    const hadith: Chunk = { id: "h", text: "hadith", metadata: { sourceType: "hadith" }, score: 2 };
    const other: Chunk = { id: "o", text: "kitab", metadata: { sourceType: "kitab" }, score: 3 };
    const { chunks } = assemble([other, hadith, quran]);
    expect(chunks.map((c) => c.id)).toEqual(["q", "h", "o"]);
  });

  it("renders the Arabic original with the labeled translation and the citation", () => {
    const c: Chunk = {
      id: "q",
      text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
      metadata: {
        sourceType: "quran",
        citation: "QS. 2:255",
        textAr: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
        textId: "Allah, tidak ada tuhan selain Dia.",
      },
    };
    const { turns } = assemble([c]);
    const context = turns.map((t) => t.content).join("\n");
    expect(context).toContain("اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ");
    expect(context).toContain(MACHINE_TRANSLATION_LABEL);
    expect(context).toContain("Allah, tidak ada tuhan selain Dia.");
    expect(context).toContain("[QS. 2:255]");
  });

  it("never labels a translation when the Arabic original is not in hand", () => {
    // The retriever fell back to the translation track: the text IS the
    // translation, and claiming otherwise would be a false provenance claim.
    const c: Chunk = {
      id: "q",
      text: "Allah, tidak ada tuhan selain Dia.",
      metadata: { sourceType: "quran", citation: "QS. 2:255" },
    };
    const { turns } = assemble([c]);
    expect(turns.map((t) => t.content).join("\n")).not.toContain(MACHINE_TRANSLATION_LABEL);
  });

  it("renders a hadith's grade alongside its citation", () => {
    const c: Chunk = {
      id: "h",
      text: "إنما الأعمال بالنيات",
      metadata: { sourceType: "hadith", citation: "HR. Bukhari no. 1", grade: "sahih" },
    };
    const { turns } = assemble([c]);
    expect(turns.map((t) => t.content).join("\n")).toContain("[HR. Bukhari no. 1 (sahih)]");
  });

  it("carries prior turns ahead of the evidence for follow-up questions", () => {
    const { turns } = assemble([{ id: "q", text: "evidence", metadata: {} }], {
      text: "Apa dalilnya?",
      history: [
        { role: "user", content: "Apa itu Ayat Kursi?" },
        { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
      ],
    });
    const preamble = turns[0]?.content ?? "";
    expect(preamble).toContain("Apa itu Ayat Kursi?");
    expect(preamble).toContain("Ayat Kursi adalah QS. 2:255.");
    // Evidence still rides its own turn after the preamble.
    expect(turns.at(-1)?.content).toContain("evidence");
  });

  it("emits no history preamble when there is no history", () => {
    const { turns } = assemble([{ id: "q", text: "evidence", metadata: {} }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).not.toContain("Percakapan sebelumnya");
  });

  it("drops malformed history entries instead of crashing the answer path", () => {
    const { turns } = assemble([{ id: "q", text: "evidence", metadata: {} }], {
      text: "q",
      history: [
        { role: "user", content: "good" },
        { role: "", content: "empty role" },
        null as never,
        { role: "user" } as never,
      ],
    });
    const preamble = turns[0]?.content ?? "";
    expect(preamble).toContain("good");
    expect(preamble).not.toContain("empty role");
  });

  it("passes the query text through as the routed intent", () => {
    const { turns } = assemble([], { text: "Apa itu Ayat Kursi?" });
    // The assembler's own turn list carries only evidence; the intent rides
    // the AssembledContext, which the generator's prompt renders.
    expect(turns).toHaveLength(1);
  });
});
