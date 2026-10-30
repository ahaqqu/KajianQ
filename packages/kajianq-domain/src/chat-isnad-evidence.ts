import { Effect } from "effect";
import type { Chunk, StoreError } from "@app/rag-core";
import { CHAIN_EVIDENCE_TRACE_LIMIT, type ChainEvidenceDetail } from "@app/contracts";
import type { NarratorChainRecord, NarratorIdsLookup } from "@app/infra";
import {
  asIsnad,
  asNarrator,
  type Isnad,
  type Narrator,
  type NarratorReliability,
} from "./narrator";

/**
 * Per-chain transmission evidence for the children retrieval put in context —
 * the read behind both the assembled prompt and the persisted `chain_evidence`
 * event (spec §9.5).
 *
 * **The invariant this module owns: the evidence a reader sees is every stored
 * transmission row for the passage, in stored order, with its own classification
 * and grader.** A citation that flattened two conflicting chains into one grade
 * would be the v1 defect v2 exists to remove, so this read never selects a "best"
 * row: `chains` is the seam's neutral insertion order, and nothing here sorts,
 * dedupes or filters it.
 *
 * **A grade is never invented.** Rows are read through `asIsnad`, which refuses a
 * grade outside the four-value vocabulary or a grade without its grader — a shape
 * the schema forbids, so seeing one means the row did not come through this
 * product's write path, and presenting a null instead would let a citation claim
 * evidence the store never held. The same refusal applies to a narrator's
 * reliability map (`asNarrator`).
 *
 * **The read is bounded and says so.** At most {@link DEFAULT_CHAIN_EVIDENCE_CHILD_CAP}
 * children and {@link CHAIN_EVIDENCE_TRACE_LIMIT} rows per child are carried. A
 * child holding more rows than its bound records `moreMayExist` so a consumer
 * presenting the prefix can say it is one; a chain-bearing child beyond the
 * child bound records itself in `notConsulted`, so a consumer marks that
 * passage unread instead of presenting the flattened headline grade as its
 * evidence. A child with no row is not an error: the event records the children
 * consulted and an empty list, which is what tells "this evidence carries no
 * transmission" apart from "nobody looked".
 */

/**
 * How many retrieved children the read covers. A hadith answer's context is
 * small by construction (the retriever's own caps), and this bound keeps the
 * per-answer store reads and the prompt growth proportional to the evidence a
 * reader actually sees.
 */
export const DEFAULT_CHAIN_EVIDENCE_CHILD_CAP = 6;

/** The read set this module needs from the store seam. */
export type ChainEvidenceStore = {
  listChainsForChild(
    childId: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorChainRecord[], StoreError>;
  getNarratorsByIds(ids: readonly string[]): Effect.Effect<NarratorIdsLookup, StoreError>;
};

/** The bridge an Effect-signatured store call goes through at the stage edge. */
export type ChainEvidenceBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

/** One resolved narrator as the evidence block renders it: name plus verdicts. */
export type IsnadNarrator = {
  readonly id: string;
  /** The catalogue's canonical Arabic spelling; absent when the catalogue lacks the id. */
  readonly nameAr: string | null;
  /** Critic → assessment, as jarh wa ta'dil records it. Empty when none is stored. */
  readonly reliability: NarratorReliability;
};

/** The transmission evidence attached to one retrieved child. */
export type IsnadEvidence = {
  /** Stored order, never re-ranked by classification. */
  readonly chains: readonly Isnad[];
  /** The narrators those chains name, first-seen order, catalogue rows only. */
  readonly narrators: readonly IsnadNarrator[];
  /** True when the child holds more rows than the bound carried. */
  readonly moreMayExist: boolean;
};

/** The metadata key the evidence rides under, so the prompt and the frame read one shape. */
export const ISNAD_EVIDENCE_KEY = "isnad";

/** The one source type whose children can carry transmission rows. */
const CHAIN_BEARING_SOURCE = "hadith";

/** The metadata key naming the source type. */
const SOURCE_TYPE_KEY = "sourceType";

function metadataOf(chunk: Chunk): Record<string, unknown> {
  return (chunk.metadata ?? {}) as Record<string, unknown>;
}

/** Whether a chunk's source is one whose passages are transmitted through chains. */
export function bearsChain(chunk: Chunk): boolean {
  return metadataOf(chunk)[SOURCE_TYPE_KEY] === CHAIN_BEARING_SOURCE;
}

/** True when the evidence carries at least one row classified weak. */
export function hasWeakChain(evidence: IsnadEvidence): boolean {
  return evidence.chains.some((chain) => chain.grade === "dhaif");
}

/**
 * Read the evidence attached to one retrieved child, or `null` when the child
 * carries none. The chain list is read one row beyond the bound so
 * `moreMayExist` is a fact rather than a guess.
 */
function readChildEvidence(input: {
  childId: string;
  store: ChainEvidenceStore;
  bridge: ChainEvidenceBridge;
  chainCap: number;
}): Effect.Effect<{ chains: Isnad[]; moreMayExist: boolean }, { cause: unknown }> {
  return Effect.tryPromise({
    try: async () => {
      const rows = await input.bridge(
        input.store.listChainsForChild(input.childId, { limit: input.chainCap + 1 }),
      );
      return {
        chains: rows.slice(0, input.chainCap).map((row) => asIsnad(row)),
        moreMayExist: rows.length > input.chainCap,
      };
    },
    catch: (cause: unknown) => ({ cause }),
  });
}

/** Resolve the narrators a set of chains names, in first-seen order. */
function readNarrators(input: {
  chains: readonly Isnad[];
  store: ChainEvidenceStore;
  bridge: ChainEvidenceBridge;
}): Effect.Effect<NarratorIdsLookup & { rows: Narrator[] }, { cause: unknown }> {
  const ids: string[] = [];
  for (const chain of input.chains) {
    for (const narratorId of chain.narratorIds) {
      if (!ids.includes(narratorId)) ids.push(narratorId);
    }
  }
  return Effect.tryPromise({
    try: async () => {
      if (ids.length === 0) return { narrators: [], missingIds: [], rows: [] };
      const lookup = await input.bridge(input.store.getNarratorsByIds(ids));
      return { ...lookup, rows: lookup.narrators.map((row) => asNarrator(row)) };
    },
    catch: (cause: unknown) => ({ cause }),
  });
}

/**
 * The per-chunk evidence, with the narrators that chunk's own chains name —
 * never the whole read's set, so a citation cannot render a narrator from a
 * different passage.
 */
function evidenceFor(chains: readonly Isnad[], narrators: readonly Narrator[]): IsnadEvidence {
  const named = new Set(chains.flatMap((chain) => [...chain.narratorIds]));
  return {
    chains,
    narrators: narrators
      .filter((narrator) => named.has(narrator.id))
      .map((narrator) => ({
        id: narrator.id,
        nameAr: narrator.canonicalNameAr.trim() === "" ? null : narrator.canonicalNameAr,
        reliability: narrator.reliabilityByCritic,
      })),
    moreMayExist: false,
  };
}

/** The capitalised display form of a stored grade (`sahih` → `Sahih`). */
export function gradeLabel(grade: string): string {
  return grade.charAt(0).toUpperCase() + grade.slice(1);
}

/**
 * Read per-chain evidence for the children in context, in retrieval order, and
 * return the chunks with it attached plus the record for the trace.
 *
 * The read is skipped entirely when no child bears a chain — a Quran-only answer
 * issues no extra store call — and `detail` is then `null`: nothing was
 * consulted, which the trace must not confuse with a read that found nothing.
 * A read budget that leaves chain-bearing children unread still records them, so
 * the frames can mark those passages instead of flattening their grade.
 */
export function readChainEvidence(input: {
  chunks: readonly Chunk[];
  store: ChainEvidenceStore;
  bridge: ChainEvidenceBridge;
  /** Children the read covers; defaults to {@link DEFAULT_CHAIN_EVIDENCE_CHILD_CAP}. */
  childCap?: number;
  /** Rows carried per child; defaults to the trace contract's own limit. */
  chainCap?: number;
}): Effect.Effect<{ chunks: Chunk[]; detail: ChainEvidenceDetail | null }, { cause: unknown }> {
  const childCap = Math.max(0, input.childCap ?? DEFAULT_CHAIN_EVIDENCE_CHILD_CAP);
  // The trace contract refuses a longer list, so clamp where the record is
  // produced: a composition root that forgets the config refusal cannot emit an
  // event the store's trace parse rejects after the answer was produced.
  const chainCap = Math.min(
    Math.max(0, input.chainCap ?? CHAIN_EVIDENCE_TRACE_LIMIT),
    CHAIN_EVIDENCE_TRACE_LIMIT,
  );
  return Effect.gen(function* () {
    const chainBearing = input.chunks.filter((chunk) => bearsChain(chunk));
    if (chainBearing.length === 0) return { chunks: [...input.chunks], detail: null };
    const candidates = chainBearing.slice(0, childCap);
    const notConsulted = chainBearing.slice(childCap).map((chunk) => chunk.id);
    const unread = notConsulted.length > 0 ? { notConsulted } : {};
    if (candidates.length === 0) {
      return {
        chunks: [...input.chunks],
        detail: {
          consulted: 0,
          perChildCap: chainCap,
          children: [],
          missingNarratorIds: [],
          ...unread,
        },
      };
    }

    const read = yield* Effect.forEach(candidates, (chunk) =>
      readChildEvidence({
        childId: chunk.id,
        store: input.store,
        bridge: input.bridge,
        chainCap,
      }),
    );
    const allChains = read.flatMap((entry) => entry.chains);
    const lookup = yield* readNarrators({
      chains: allChains,
      store: input.store,
      bridge: input.bridge,
    });

    const byId = new Map(candidates.map((chunk, index) => [chunk.id, read[index]]));
    const enriched = input.chunks.map((chunk) => {
      const entry = byId.get(chunk.id);
      if (entry === undefined || entry.chains.length === 0) return chunk;
      const evidence: IsnadEvidence = {
        ...evidenceFor(entry.chains, lookup.rows),
        moreMayExist: entry.moreMayExist,
      };
      return {
        ...chunk,
        metadata: { ...metadataOf(chunk), [ISNAD_EVIDENCE_KEY]: evidence },
      };
    });

    const children = candidates.flatMap((chunk) => {
      const entry = byId.get(chunk.id);
      if (entry === undefined || entry.chains.length === 0) return [];
      return [
        {
          childId: chunk.id,
          chains: entry.chains.map((chain) => ({
            narratorIds: [...chain.narratorIds],
            ...(chain.grade === null || chain.grader === null
              ? {}
              : { grade: chain.grade, grader: chain.grader }),
            ...(chain.sourceRef === null ? {} : { sourceRef: chain.sourceRef }),
          })),
          ...(entry.moreMayExist ? { moreMayExist: true } : {}),
        },
      ];
    });

    return {
      chunks: enriched,
      detail: {
        consulted: candidates.length,
        perChildCap: chainCap,
        children,
        missingNarratorIds: [...lookup.missingIds],
        ...unread,
      },
    };
  });
}

/**
 * The evidence attached to a chunk, when it carries one. Read through this
 * accessor rather than casting at each call site so the metadata shape has one
 * owner.
 */
export function isnadEvidenceOf(chunk: Chunk): IsnadEvidence | null {
  const raw = metadataOf(chunk)[ISNAD_EVIDENCE_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const evidence = raw as IsnadEvidence;
  return Array.isArray(evidence.chains) && Array.isArray(evidence.narrators) ? evidence : null;
}
