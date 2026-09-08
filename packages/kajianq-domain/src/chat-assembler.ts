import { Effect } from "effect";
import {
  toStageError,
  type AssembledContext,
  type Assembler,
  type Chunk,
  type Query,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/**
 * KajianQAssembler — Smart Router stage 5 (spec §3.3): order the retrieved
 * chunks into the Generator's turn list. Presentation order: Quran first,
 * then hadith, then other sources (kitab lands later); each chunk's citation
 * label rides the context so the Generator can cite verbatim. Deterministic —
 * the runner records the `assembly` boundary event from the result.
 */

/** Presentation rank per source type (opaque metadata keys, spec §3.3.5). */
function presentationRank(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  if (meta["sourceType"] === "quran") return 0;
  if (meta["sourceType"] === "hadith") return 1;
  return 2;
}

/** One evidence block as the prompt renders it. */
function renderChunk(chunk: Chunk): string {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = typeof meta["citation"] === "string" ? meta["citation"] : "";
  const grade = typeof meta["grade"] === "string" ? ` (${meta["grade"]})` : "";
  const label = citation !== "" ? ` [${citation}${grade}]` : "";
  return `${chunk.text}${label}`;
}

export function createKajianQAssembler(): Assembler<KajianQFilters> {
  return {
    assemble: (query: Query<KajianQFilters>, chunks: readonly Chunk[]) =>
      toStageError(
        "assembler",
        Effect.sync(() => {
          const ordered = [...chunks].sort(
            (a, b) =>
              presentationRank(a) - presentationRank(b) || (b.score ?? 0) - (a.score ?? 0),
          );
          const context = ordered.map(renderChunk).join("\n\n");
          const ctx: AssembledContext<KajianQFilters> = {
            query: {
              intent: query.text,
              subQueries: [{ text: query.text }],
              filters: query.filters ?? {},
            },
            chunks: ordered,
            turns: [{ role: "user", content: context }],
          };
          return ctx;
        }),
      ),
  };
}