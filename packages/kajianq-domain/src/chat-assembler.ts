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
 * KajianQAssembler — Smart Router stage 5: order the retrieved chunks into the
 * Generator's turn list. Presentation order is {@link PRESENTATION_ORDER}, never the
 * authority order the system prompt states; within a slot, fused score decides. The result
 * is deterministic — the runner records the `assembly` boundary event from it.
 *
 * Two product rules live here:
 *
 * - an Arabic original accompanies every quoted passage, and a machine translation is
 *   labelled as such (ADR-0006), so the model never reproduces Arabic from memory;
 * - prior turns are rendered ahead of the evidence as their own turns, so a follow-up
 *   resolves against what was already asked.
 */

/**
 * The **presentation order** (spec §3.3 item 5): Principles → Quran → Tafsir → Hadith →
 * Kitab — *how the Generator's turn is laid out*, deliberately NOT the usul **authority
 * order** the system prompt enforces. The Principle lens comes first because it is the
 * reading frame for everything after it. `tafsir` sits after `quran` (commentary with the
 * text it explains), and an unlisted source type sorts LAST, below every named source.
 */
export const PRESENTATION_ORDER: readonly string[] = [
  "principle",
  "quran",
  "tafsir",
  "hadith",
  "kitab",
];

function presentationRank(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const sourceType = meta["sourceType"];
  const rank = typeof sourceType === "string" ? PRESENTATION_ORDER.indexOf(sourceType) : -1;
  return rank === -1 ? PRESENTATION_ORDER.length : rank;
}

/** The machine-translation label (ADR-0006). Domain vocabulary lives here. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/** One evidence block, exactly as the Generator's prompt renders it — exported so the
 * Reviewer is shown the SAME evidence and cannot disagree with the prompt. */
export function renderEvidenceChunk(chunk: Chunk): string {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = typeof meta["citation"] === "string" ? meta["citation"] : "";
  // The corpus citation may already carry the grade ("HR. Malik no. 187 (Sahih)"), so add
  // it only when the label lacks it — a duplicated grade reads as a modified citation.
  const gradeName = typeof meta["grade"] === "string" ? meta["grade"] : "";
  const grade =
    gradeName !== "" && !citation.toLowerCase().includes(gradeName.toLowerCase())
      ? ` (${gradeName})`
      : "";
  const label = citation !== "" ? ` [${citation}${grade}]` : "";
  // Arabic original first, then the display translation — the label is emitted only when
  // both layers are in hand, never claiming a translation of the original itself.
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
          // The context carries the *routed* query itself — the run's query context plus
          // the router's reading — never a rebuilt lookalike (ADR-0018).
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

/** Prior turns ride the routed query, stamped there by the engine. Malformed entries are
 * dropped rather than crashing the answer path — a bad history row must not take down a
 * question. */
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
