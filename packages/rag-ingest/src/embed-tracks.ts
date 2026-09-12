import { Data, Effect } from "effect";
import type { DocChildInsert } from "@app/infra";
import type { CostCollector, IngestionDeps } from "./types";

/**
 * A batch's vector count did not match its text count — the embedder
 * violated the seam contract. Tagged (B1) and typed-error compliant
 * (ADR-0027 need 1).
 */
export class EmbedMisalignment extends Data.TaggedError("EmbedMisalignment")<{
  readonly expected: number;
  readonly received: number;
}> {}

/**
 * The dual-track embedding step of an ingestion run, split from `pipeline.ts`
 * to keep both modules under the agentic size limit. Still engine code: it
 * knows about two opaque text tracks and their row alignment, never about a
 * corpus, a language, or a citation format.
 */

/**
 * Embed texts in batches, collecting cost per call. Returns row-aligned
 * vectors; empty input performs no call and records no cost.
 *
 * Batches run under `Effect.forEach` with `deps.embedConcurrency` (default 1:
 * fully serial). Results stay row-aligned regardless of concurrency, and a
 * batch whose vector count mismatches fails the whole run — a partially
 * embedded child row must never be written.
 */
export async function embedBatched(
  deps: IngestionDeps,
  texts: readonly string[],
  costs: CostCollector,
): Promise<readonly (readonly number[])[]> {
  const batchSize = deps.embedBatchSize ?? 64;
  const batches: (readonly string[])[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }
  const embedOne = (batch: readonly string[]) =>
    Effect.gen(function* () {
      const result = yield* deps.embedder.embed({ texts: batch });
      // Record-then-validate (traceability rule 4): a misaligned response is
      // still a billed vendor call — its cost reaches the collector before
      // the shape check fails the run.
      costs.record(result.cost);
      if (result.vectors.length !== batch.length) {
        return yield* Effect.fail(
          new EmbedMisalignment({
            expected: batch.length,
            received: result.vectors.length,
          }),
        );
      }
      return result.vectors;
    });
  const concurrency = deps.embedConcurrency ?? 1;
  const batchVectors = await Effect.runPromise(Effect.forEach(batches, embedOne, { concurrency }));
  return batchVectors.flat();
}

/** One row's text for a track, or null when the row does not carry it. */
type TrackPick = (row: DocChildInsert) => string | null;

/**
 * Embed one track over the rows that actually carry text, returning a
 * row-index → vector map (null when no row carries the track).
 *
 * Why rows are filtered instead of embedded as `""`: an empty or blank string
 * is not a request a vendor will accept — the live API answers `400 … contains
 * an empty Part` — and the corpus legitimately contains rows without a
 * secondary-language text (mapping `null` to `""` sent one empty part per such
 * row and failed a whole ingestion run after hours of embedding). A row with no
 * text for a track keeps a null vector; a placeholder would pollute the index.
 */
async function embedTrack(
  deps: IngestionDeps,
  childRows: readonly DocChildInsert[],
  pick: TrackPick,
  costs: CostCollector,
): Promise<Map<number, readonly number[]> | null> {
  const present = childRows.flatMap((row, index) => {
    const text = pick(row);
    return text !== null && text.trim() !== "" ? [{ index, text }] : [];
  });
  if (present.length === 0) return null;
  const vectors = await embedBatched(
    deps,
    present.map((p) => p.text),
    costs,
  );
  const byRow = new Map<number, readonly number[]>();
  present.forEach((p, k) => byRow.set(p.index, vectors[k] ?? []));
  return byRow;
}

/** Both tracks of one run, each aligned to its child row index. */
export type EmbeddedTracks = {
  primaryByRow: Map<number, readonly number[]> | null;
  secondaryByRow: Map<number, readonly number[]> | null;
};

/** Embed both tracks of a child list (primary first, then secondary). */
export async function embedTracks(
  deps: IngestionDeps,
  childRows: readonly DocChildInsert[],
  costs: CostCollector,
): Promise<EmbeddedTracks> {
  return {
    primaryByRow: await embedTrack(deps, childRows, (row) => row.textAr, costs),
    secondaryByRow: await embedTrack(deps, childRows, (row) => row.textId, costs),
  };
}
