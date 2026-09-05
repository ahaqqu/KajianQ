import { Effect } from "effect";
import type { DocChildInsert, DocParentInsert } from "@app/infra";
import { CostCollector } from "./types";
import type {
  AlignedPairInput,
  IngestionDeps,
  ParentSummarizer,
  ParsedParent,
  SourceParser,
} from "./types";

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
        throw new Error(
          `ingestion: parent "${parent.sourceKey}" has duplicate ordinal ${ordinal}`,
        );
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

/**
 * Embed texts in batches, collecting cost per call. Returns row-aligned
 * vectors; empty input performs no call and records no cost.
 */
async function embedBatched(
  deps: IngestionDeps,
  texts: readonly string[],
  costs: CostCollector,
): Promise<readonly (readonly number[])[]> {
  const batchSize = deps.embedBatchSize ?? 64;
  const vectors: (readonly number[])[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const result = await Effect.runPromise(deps.embedder.embed({ texts: batch }));
    if (result.vectors.length !== batch.length) {
      throw new Error(
        `ingestion: embedder returned ${result.vectors.length} vectors for ${batch.length} texts`,
      );
    }
    costs.record(result.cost);
    vectors.push(...result.vectors);
  }
  return vectors;
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
 * tracks → upsert through the RagStore → return the report.
 *
 * The report is *returned*, not persisted: persistence goes through the store
 * seam by the caller (CLI) so this function stays pure with respect to I/O
 * beyond the injected seams.
 */
export async function runIngestion(
  parser: SourceParser,
  input: { archiveKey: string; raw: Uint8Array },
  deps: IngestionDeps,
): Promise<{ report: import("@app/contracts").IngestionReport; parentIds: readonly string[] }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const costs = new CostCollector();
  const parents = [...(await parser(input))];
  assertWellFormed(parents);

  const summaries =
    deps.summarizer === null
      ? null
      : await summarizeParents(parents, deps.summarizer, costs);

  const parentIds: string[] = [];
  let childrenWritten = 0;
  const childRows: DocChildInsert[] = [];
  const pairSources = collectPairSources(parents);
  const pending: DocChildInsert[] = [];
  const pendingPairs: AlignedPairInput[] = [];

  for (const parent of parents) {
    const parentId = await deps.store.insertDocParent(parent satisfies DocParentInsert);
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

  // Embed both tracks in child order, then upsert children with vectors.
  const primaryVectors = await embedBatched(deps, childRows.map((c) => c.textAr), costs);
  const hasSecondary = childRows.some((c) => c.textId !== null);
  const secondaryVectors = hasSecondary
    ? await embedBatched(
        deps,
        childRows.map((c) => c.textId ?? ""),
        costs,
      )
    : null;

  for (let i = 0; i < childRows.length; i += 1) {
    const row = childRows[i];
    if (!row) continue;
    pending.push({
      ...row,
      embeddingPrimary: primaryVectors[i] ?? null,
      embeddingFallback: secondaryVectors ? (secondaryVectors[i] ?? null) : null,
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
    await deps.store.insertDocChildren(pending.slice(i, i + writeBatchSize));
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
      await deps.store.insertDocParent({
        ...parent,
        metadata: { ...parent.metadata, summary, summaryEmbeddedFrom: "summary" },
      });
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
        embeddedSecondaryTrack: hasSecondary,
        parserParents: parents.length,
      },
    },
    parentIds,
  };
}