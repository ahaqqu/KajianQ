import { Effect } from "effect";
import {
  toStageError,
  type AssembledContext,
  type Assembler,
  type Chunk,
  type RoutedQuery,
  type Turn,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/**
 * KajianQAssembler — Smart Router stage 5 (spec §3.3): order the retrieved
 * chunks into the Generator's turn list. Presentation order is
 * {@link PRESENTATION_ORDER} (Principles → Quran → Hadith → Kitab → concept
 * links), never the authority order the system prompt states; within a slot,
 * fused score decides. Each chunk's citation label rides the context so the
 * Generator can cite verbatim. Deterministic — the runner records the
 * `assembly` boundary event from the result.
 *
 * Two product rules live here (ticket #10 acceptance criteria):
 *
 * - **Arabic originals accompany every quoted passage, and a machine
 *   translation is labeled as such** (ADR-0006: the label "Terjemahan mesin —
 *   lihat teks Arab asli"). The assembler renders both layers per chunk, so
 *   the model is never asked to reproduce Arabic from memory.
 * - **Follow-up questions use conversation context.** Prior turns are
 *   rendered ahead of the evidence as their own turns, so the model can
 *   resolve "dan apa dalilnya?" against what was already asked.
 */

/**
 * The **presentation order** (spec §3.3 item 5): Principles → Quran → Hadith →
 * Kitab → concept links. It is *how the Generator's turn is laid out*, and it
 * is deliberately NOT the usul **authority order** the system prompt enforces
 * (Quran → Hadith → Tafsir → Kitab): the Principle lens is presented first
 * because it is the reading frame for everything after it, while the prompt
 * says which source governs when they disagree. Conflating the two — sorting
 * the evidence by authority and dropping the lens to the back, or reading the
 * presentation order as a claim about authority — is the silent failure this
 * constant exists to prevent, so the order is stated once, here, and pinned by
 * its own test.
 *
 * `tafsir` sits immediately after `quran` (commentary with the text it
 * explains) — the spec's presentation list does not name it, and the authority
 * order puts it third; being explicit keeps it out of the trailing bucket where
 * a future source type would land by accident. Anything the corpus grows that
 * is not listed here sorts LAST, below every named source, never interleaved by
 * score into a slot it was not given.
 */
export const PRESENTATION_ORDER: readonly string[] = [
  "principle",
  "quran",
  "tafsir",
  "hadith",
  "kitab",
];

/** Presentation rank per source type; an unlisted source type sorts last. */
function presentationRank(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const sourceType = meta["sourceType"];
  const rank = typeof sourceType === "string" ? PRESENTATION_ORDER.indexOf(sourceType) : -1;
  return rank === -1 ? PRESENTATION_ORDER.length : rank;
}

/** The machine-translation label (ADR-0006). Domain vocabulary lives here. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * One evidence block, exactly as the Generator's prompt renders it. Exported
 * because the Reviewer must be shown the SAME evidence: its lines used to be
 * `- ${chunk.text}`, which for a fallback-track hit is the Indonesian layer
 * only, so the Reviewer failed answers that quoted the Arabic the Generator
 * had (and the label) as "absent from the evidence". One renderer, two
 * readers — the gate cannot disagree with the prompt about what was provided.
 */
export function renderEvidenceChunk(chunk: Chunk): string {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = typeof meta["citation"] === "string" ? meta["citation"] : "";
  // The corpus citation already carries the grade for hadith ("HR. Malik no.
  // 187 (Sahih)"); appending it again produced "(Sahih) (sahih)" in the label,
  // which the Generator copied verbatim and the Reviewer then failed as a
  // modified citation. Only add the grade when the label lacks it.
  const gradeName = typeof meta["grade"] === "string" ? meta["grade"] : "";
  const grade =
    gradeName !== "" && !citation.toLowerCase().includes(gradeName.toLowerCase())
      ? ` (${gradeName})`
      : "";
  const label = citation !== "" ? ` [${citation}${grade}]` : "";
  // The evidence line: Arabic original first, then the display translation.
  // `chunk.text` is the track the retriever selected (ADR-0013: the primary
  // track is the canonical Arabic evidence); the retriever also carries both
  // text layers on the metadata (`textAr`/`textId`, thermo-review A1), so the
  // label is emitted only when both layers are actually in hand — it must
  // never claim a translation accompanies text that is already the original.
  const original = typeof meta["textAr"] === "string" ? meta["textAr"] : null;
  const translation = typeof meta["textId"] === "string" ? meta["textId"] : null;
  if (original !== null && original !== "" && translation !== null && translation !== "") {
    return `${original}\n(${MACHINE_TRANSLATION_LABEL})\n${translation}${label}`;
  }
  return `${chunk.text}${label}`;
}

/** The prior-conversation preamble (empty string when there is no history). */
function renderHistory(history: readonly { role: string; content: string }[]): string {
  if (history.length === 0) return "";
  return [
    "Percakapan sebelumnya / Previous conversation:",
    ...history.map((m) => `${m.role}: ${m.content}`),
  ].join("\n");
}

export function createKajianQAssembler(): Assembler<KajianQFilters> {
  return {
    assemble: (routed: RoutedQuery<KajianQFilters>, chunks: readonly Chunk[]) =>
      toStageError(
        "assembler",
        Effect.sync(() => {
          const ordered = [...chunks].sort(
            (a, b) => presentationRank(a) - presentationRank(b) || (b.score ?? 0) - (a.score ?? 0),
          );
          const context = ordered.map(renderEvidenceChunk).join("\n\n");
          const history = historyOf(routed);
          const preamble = renderHistory(history);
          const turns: Turn[] = [];
          if (preamble !== "") turns.push({ role: "user", content: preamble });
          turns.push({ role: "user", content: context });
          // The context carries the *routed* query itself — the run's query
          // context (verbatim question, history) plus the router's reading
          // (intent, sub-queries, filters). Rebuilding a lookalike here is what
          // let the verbatim question ride the field named `intent` (ADR-0018).
          const ctx: AssembledContext<KajianQFilters> = {
            query: routed,
            chunks: ordered,
            turns,
          };
          return ctx;
        }),
      ),
  };
}

/**
 * Prior turns ride the routed query (ADR-0018: the engine stamps the caller's
 * `Query.history` onto it and carries it opaquely; the domain pack renders it).
 * Malformed entries are dropped rather than crashing the answer path — a bad
 * history row must not take down a question.
 */
function historyOf(routed: RoutedQuery<KajianQFilters>): Turn[] {
  const raw = routed.history;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((turn) => {
    if (turn === null || typeof turn !== "object") return [];
    const { role, content } = turn as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || typeof content !== "string") return [];
    if (role === "" || content === "") return [];
    return [{ role, content }];
  });
}
