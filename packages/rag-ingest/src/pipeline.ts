import { Effect } from "effect";
import type { StoreError } from "@app/rag-core";
import type { DocChildInsert, DocParentInsert } from "@app/infra";
import { embedTracks } from "./embed-tracks";
// Re-exported so the module that defines the pipeline's typed failure stays
// the pipeline's public surface (tests and callers import it from here).
export { EmbedMisalignment } from "./embed-tracks";
import {
  CostCollector,
  type AlignedPairInput,
  type IngestionDeps,
  type ParentSummarizer,
  type ParsedParent,
  type SourceParser,
} from "./types";

/**
 * The single off-Workers bridge (ADR-0027 decision 3): the ingestion runner
 * is promise-shaped; this runPromise joins the store-seam Effects
 * (`Effect<A, StoreError>`) to it — a typed failure rejects with the
 * StoreError itself. Exported so the ingestion CLIs bridge their direct
 * store calls (`insertEvalRun`) through the same edge instead of holding
 * an `effect` import.
 */
export const runStoreEffect = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> =>
  Effect.runPromise(effect);

/**
 * rag-ingest — the domain-agnostic ingestion pipeline orchestration (#6).
 *
 * Source parsing is domain work and arrives through the `SourceParser` seam
 * (see `types.ts`): the engine never names a corpus, a language, or a
 * citation format. What the engine owns is the *shape* of an ingestion run:
 * parse → summarize parents (LLM, costed) → embed both tracks (costed) →
 * upsert through the RagStore → emit an `IngestionReport`
 * (kajianq-traceability rule 4: batch jobs produce reports, stored and
 * citable, never skipped).
 *
 * Idempotency (AGENTS.md rule 11) is delegated to the store: parents upsert
 * by `sourceKey`, children by `(parentId, ordinal)` — the engine asserts the
 * invariants it needs (unique keys, stable ordinals) before writing so a bad
 * parser fails loudly at the seam instead of duplicating rows.
 */

/** Assert a parser produced upsertable documents: unique keys, no empty primary text. */
function assertWellFormed(parents: readonly ParsedParent[]): void {
  const seen = new Set<string>();
  for (const parent of parents) {
    if (seen.has(parent.sourceKey)) {
      throw new Error(`ingestion: duplicate parent sourceKey "${parent.sourceKey}"`);
    }
    seen.add(parent.sourceKey);
    if (parent.children.length === 0) {
      throw new Error(`ingestion: parent "${parent.sourceKey}" has no children`);
    }
    const ordinals = new Set<number>();
    parent.children.forEach((child, i) => {
      if (child.textPrimary.trim().length === 0) {
        throw new Error(
          `ingestion: parent "${parent.sourceKey}" child ${i} has empty primary text`,
        );
      }
      const ordinal = child.ordinal ?? i;
      if (ordinals.has(ordinal)) {
        throw new Error(`ingestion: parent "${parent.sourceKey}" has duplicate ordinal ${ordinal}`);
      }
      ordinals.add(ordinal);
    });
  }
}

async function summarizeParents(
  parents: readonly ParsedParent[],
  summarizer: ParentSummarizer,
  costs: CostCollector,
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  for (const parent of parents) {
    const { summary, cost } = await summarizer({
      sourceKey: parent.sourceKey,
      title: parent.title,
      // Summary input is the child texts; the summary becomes the embedded
      // parent text (issue #6: parent embeddings from summaries).
      childTexts: parent.children.map((c) => c.textPrimary),
    });
    if (summary.trim().length === 0) {
      throw new Error(`ingestion: summarizer returned empty summary for "${parent.sourceKey}"`);
    }
    // The summarizer's LLM call is costed like every other call — the
    // report's cost equals the sum of recorded calls (review A6).
    costs.record(cost);
    summaries.set(parent.sourceKey, summary);
  }
  return summaries;
}

/** Collect the aligned pairs a parsed child list implies (rows with a secondary track). */
function collectPairSources(parents: readonly ParsedParent[]): Map<number, AlignedPairInput> {
  const sources = new Map<number, AlignedPairInput>();
  let index = 0;
  for (const parent of parents) {
    for (const child of parent.children) {
      if (child.textSecondary !== null) {
        sources.set(index, {
          pairKey: child.sourceKey,
          citation: child.citation,
          textPrimary: child.textPrimary,
          textSecondary: child.textSecondary,
          morphology: Array.isArray(child.metadata.morphology)
            ? (child.metadata.morphology as readonly Record<string, unknown>[])
            : [],
        });
      }
      index += 1;
    }
  }
  return sources;
}

/**
 * Run one ingestion pass: parse → (optional) summarize parents → embed both
 * tracks → upsert through the RagStore → return the report. The report is
 * *returned*, not persisted: persistence goes through the store seam by the
 * caller (CLI) so this function stays pure with respect to I/O beyond the
 * injected seams.
 */
export async function runIngestion(
  parser: SourceParser,
  input: { archiveKey: string; raw: Uint8Array },
  deps: IngestionDeps,
): Promise<{ report: import("@app/contracts").IngestionReport; parentIds: readonly string[] }> {
  const concurrency = deps.embedConcurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    // Fail loudly (C2): a misconfiguration (0 = "unlimited"?) must never
    // silently degrade to serial — effect@3.22.1 would run it sequential.
    throw new RangeError(
      `ingestion: embedConcurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const costs = new CostCollector();
  const parents = [...(await parser(input))];
  assertWellFormed(parents);

  const summaries =
    deps.summarizer === null ? null : await summarizeParents(parents, deps.summarizer, costs);

  const parentIds: string[] = [];
  let childrenWritten = 0;
  const childRows: DocChildInsert[] = [];
  const pairSources = collectPairSources(parents);
  const pending: DocChildInsert[] = [];
  const pendingPairs: AlignedPairInput[] = [];

  for (const parent of parents) {
    const parentId = await runStoreEffect(
      deps.store.insertDocParent(parent satisfies DocParentInsert),
    );
    parentIds.push(parentId);
    parent.children.forEach((child, i) => {
      childRows.push({
        parentId,
        textRaw: child.textRaw,
        textAr: child.textPrimary,
        textId: child.textSecondary,
        citation: child.citation,
        metadata: child.metadata,
        ordinal: child.ordinal ?? i,
        embeddingPrimary: null,
        embeddingFallback: null,
      });
    });
  }

  // Embed both tracks in child order, then upsert children with vectors. The
  // per-track rules (only rows that actually carry text are embedded; a null
  // track keeps a null vector) live in embed-tracks.ts.
  const { primaryByRow, secondaryByRow } = await embedTracks(deps, childRows, costs);

  for (let i = 0; i < childRows.length; i += 1) {
    const row = childRows[i];
    if (!row) continue;
    pending.push({
      ...row,
      embeddingPrimary: primaryByRow?.get(i) ?? null,
      embeddingFallback: secondaryByRow?.get(i) ?? null,
    });
    childrenWritten += 1;
    if (deps.pairSink) {
      const pair = pairSources.get(i);
      if (pair !== undefined) pendingPairs.push(pair);
    }
  }

  // Batch the store writes so the store adapter can use multi-row upserts.
  // Pairs are not tied to the child write windows — they are drained on
  // their own so the batching of one never silently drops or reorders the
  // other (they coincide 1:1 today, but the seams are independent).
  const writeBatchSize = deps.writeBatchSize ?? 64;
  for (let i = 0; i < pending.length; i += writeBatchSize) {
    await runStoreEffect(deps.store.insertDocChildren(pending.slice(i, i + writeBatchSize)));
  }
  if (deps.pairSink) {
    for (const pair of pendingPairs) await deps.pairSink(pair);
  }

  // Surah summaries attach to the parent via a metadata refresh — a single
  // upsert keyed by sourceKey stays idempotent, so re-running ingestion does
  // not duplicate parents (AGENTS.md rule 11).
  if (summaries !== null) {
    for (const parent of parents) {
      const summary = summaries.get(parent.sourceKey);
      if (summary === undefined) continue;
      await runStoreEffect(
        deps.store.insertDocParent({
          ...parent,
          metadata: { ...parent.metadata, summary, summaryEmbeddedFrom: "summary" },
        }),
      );
    }
  }

  return {
    report: {
      runId: crypto.randomUUID(),
      sourceKey: input.archiveKey,
      startedAt,
      finishedAt: now(),
      parentsWritten: parentIds.length,
      childrenWritten,
      quarantined: 0,
      costMicroUsd: costs.costMicroUsd,
      llmCalls: [...costs.calls],
      details: {
        // True when at least one row carried a secondary track to embed.
        embeddedSecondaryTrack: secondaryByRow !== null,
        parserParents: parents.length,
      },
    },
    parentIds,
  };
}
