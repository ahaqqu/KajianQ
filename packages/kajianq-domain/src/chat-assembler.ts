import { Effect } from "effect";
import {
  toStageError,
  type AssembledContext,
  type Assembler,
  type Chunk,
  type Query,
  type Turn,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/**
 * KajianQAssembler — Smart Router stage 5 (spec §3.3): order the retrieved
 * chunks into the Generator's turn list. Presentation order: Quran first,
 * then hadith, then other sources (kitab lands later); each chunk's citation
 * label rides the context so the Generator can cite verbatim. Deterministic —
 * the runner records the `assembly` boundary event from the result.
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

/** Presentation rank per source type (opaque metadata keys, spec §3.3.5). */
function presentationRank(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  if (meta["sourceType"] === "quran") return 0;
  if (meta["sourceType"] === "hadith") return 1;
  return 2;
}

/** The machine-translation label (ADR-0006). Domain vocabulary lives here. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/** One evidence block as the prompt renders it. */
function renderChunk(chunk: Chunk): string {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = typeof meta["citation"] === "string" ? meta["citation"] : "";
  const grade = typeof meta["grade"] === "string" ? ` (${meta["grade"]})` : "";
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
    assemble: (query: Query<KajianQFilters>, chunks: readonly Chunk[]) =>
      toStageError(
        "assembler",
        Effect.sync(() => {
          const ordered = [...chunks].sort(
            (a, b) => presentationRank(a) - presentationRank(b) || (b.score ?? 0) - (a.score ?? 0),
          );
          const context = ordered.map(renderChunk).join("\n\n");
          const history = historyOf(query);
          const preamble = renderHistory(history);
          const turns: Turn[] = [];
          if (preamble !== "") turns.push({ role: "user", content: preamble });
          turns.push({ role: "user", content: context });
          const ctx: AssembledContext<KajianQFilters> = {
            query: {
              intent: query.text,
              subQueries: [{ text: query.text }],
              filters: query.filters ?? {},
            },
            chunks: ordered,
            turns,
          };
          return ctx;
        }),
      ),
  };
}

/**
 * Prior turns ride `Query.history` (the ADR-0018 amendment: the engine carries
 * multi-turn context opaquely, the domain pack renders it). Malformed entries
 * are dropped rather than crashing the answer path — a bad history row must
 * not take down a question.
 */
function historyOf(query: Query<KajianQFilters>): Turn[] {
  const raw = query.history;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((turn) => {
    if (turn === null || typeof turn !== "object") return [];
    const { role, content } = turn as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || typeof content !== "string") return [];
    if (role === "" || content === "") return [];
    return [{ role, content }];
  });
}
