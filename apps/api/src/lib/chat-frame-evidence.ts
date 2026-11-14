import type { ChatChain, ChatTraceChunk, Trace, TraceEvent } from "@app/contracts";
import type { DocChildById, NarratorIdsLookup, RagStore } from "@app/infra";
import {
  citationCandidatesIn,
  citationLabelsOf,
  groundingLabelsFor,
  normalizeCitationLabel,
  type StoreBridge,
} from "@app/kajianq-domain";
import type { Warn } from "./chat-trace";

/**
 * The evidence joins the two user-facing frames need: the per-chain record the
 * citation sheet renders, and which of the retrieved passages the answer
 * actually cited (the Trace panel's top layer).
 *
 * **The chain record is the persisted trace, not a fresh read.** Rows come from
 * the answer's own `chain_evidence` event, projected in the event's order and
 * never re-read from the store — the same posture the citations and trace frames
 * take for chunks (ADR-0007). The one store join is the narrator's display
 * spelling, resolved by the ids the event recorded, exactly as a chunk's title
 * is.
 *
 * **Degradation is honest by omission.** A narrator the catalogue cannot resolve
 * loses only its `nameAr`; the chain keeps the id, because dropping the narrator
 * would present a different transmission than the one read. A failed narrator read
 * degrades the whole join the same way, with one warning — the panel renders ids
 * rather than inventing names.
 */

/** The display row this module joins: a narrator's catalogue id and Arabic spelling. */
export type NarratorSource = (ids: readonly string[]) => Promise<NarratorIdsLookup>;

/** The catalogue join over the store seam (the bridge stays at this edge). */
export function narratorFetcher(
  store: Pick<RagStore, "getNarratorsByIds">,
  runStore: StoreBridge,
): NarratorSource {
  return async (ids) => runStore(store.getNarratorsByIds(ids));
}

/** One persisted transmission row, as the event recorded it. */
type RecordedChain = Extract<TraceEvent, { kind: "chain_evidence" }>["detail"]["children"][number];

/** The evidence one trace records, keyed by child, plus the ids its narrators need. */
export type RecordedEvidence = {
  /** Child id → the rows the read returned, in the event's (stored) order. */
  byChild: ReadonlyMap<string, RecordedChain>;
  /** Chain-bearing children the read did not cover, in retrieval order. */
  notConsulted: readonly string[];
  /** Every narrator id the rows name, in first-seen order — the display join's input. */
  narratorIds: readonly string[];
};

/** The trace's chain-evidence record, or `null` when the run recorded none. */
export function recordedEvidence(trace: Trace): RecordedEvidence | null {
  const events = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "chain_evidence" }> =>
      event.kind === "chain_evidence",
  );
  if (events.length === 0) return null;
  const byChild = new Map<string, RecordedChain>();
  const narratorIds: string[] = [];
  const notConsulted: string[] = [];
  for (const event of events) {
    for (const child of event.detail.children) {
      byChild.set(child.childId, child);
      for (const chain of child.chains) {
        for (const id of chain.narratorIds) {
          if (!narratorIds.includes(id)) narratorIds.push(id);
        }
      }
    }
    for (const id of event.detail.notConsulted ?? []) {
      if (!notConsulted.includes(id)) notConsulted.push(id);
    }
  }
  return { byChild, notConsulted, narratorIds };
}

/** The resolved display spelling per narrator id; absent means the catalogue lacks it. */
export type NarratorNames = ReadonlyMap<string, string>;

/**
 * Resolve the display spelling of every narrator an evidence record names. A read
 * failure degrades to an EMPTY map (ids render in the place of names) with the
 * caller's structured warning — never a fabricated name.
 */
export async function narratorNamesOrEmpty(input: {
  ids: readonly string[];
  fetchNarrators: NarratorSource | undefined;
  warn: Warn;
  warnKey: string;
  warnFields: Record<string, string | number | boolean | null>;
}): Promise<NarratorNames> {
  if (input.fetchNarrators === undefined || input.ids.length === 0) return new Map();
  try {
    const lookup = await input.fetchNarrators(input.ids);
    return new Map(
      lookup.narrators.flatMap((row) =>
        row.canonicalNameAr.trim() === "" ? [] : [[row.id, row.canonicalNameAr] as const],
      ),
    );
  } catch (err) {
    input.warn(input.warnKey, {
      ...input.warnFields,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/** Project one recorded row into the wire shape the sheet and the panel share. */
function toCitationChain(chain: RecordedChain["chains"][number], names: NarratorNames): ChatChain {
  return {
    narrators: chain.narratorIds.map((id) => {
      const name = names.get(id);
      return { id, ...(name !== undefined ? { nameAr: name } : {}) };
    }),
    ...(chain.grade !== undefined ? { grade: chain.grade } : {}),
    ...(chain.grader !== undefined ? { grader: chain.grader } : {}),
    ...(chain.sourceRef !== undefined ? { sourceRef: chain.sourceRef } : {}),
  };
}

/** What a citation should render for one child: its rows, or the fact nobody read them. */
export type CitationEvidence =
  | { readonly chains: ChatChain[]; readonly unread?: undefined }
  | { readonly unread: true };

/**
 * The evidence a cited child carries: its rows projected verbatim — every row,
 * in the recorded order, so the sheet cannot present one grade for a passage
 * whose chains disagree — the explicit unread fact when the read budget left the
 * child out, or `undefined` when the trace recorded no evidence for it at all.
 *
 * The unread case must stay distinct from the no-record case: the first says
 * chain-bearing rows exist but were never read, and a renderer may not fall back
 * to the passage's flattened headline grade for it.
 */
export function citationEvidenceFor(
  childId: string,
  evidence: RecordedEvidence | null,
  names: NarratorNames,
): CitationEvidence | undefined {
  const recorded = evidence?.byChild.get(childId);
  if (recorded !== undefined) {
    return {
      chains: recorded.chains.map((chain) => ({
        ...toCitationChain(chain, names),
        ...(recorded.moreMayExist === true ? { moreMayExist: true } : {}),
      })),
    };
  }
  return evidence?.notConsulted.includes(childId) === true ? { unread: true } : undefined;
}

/** One cited span the gate grounded, and the chunk that grounds it. */
export type CitedRow = { label: string; chunk: DocChildById };

/**
 * The answer's cited-and-grounded spans, each with the chunk that grounds it:
 * the citation sheet's rows and, one per chunk, the Trace panel's cited
 * sources. The grounding decision is the gate's (`groundingLabelsFor`), so the
 * panel and the gate cannot disagree; the chunk ids are the trace's own
 * retrieval refs, so a chunk the run never retrieved can never appear.
 *
 * A span keeps the form the answer wrote (`QS. 3:1-2`) while the chunk that
 * backs it is the first retrieved address the gate grounded (the range's head):
 * the same split the citation chips use.
 */
export function citedSourcesOf(input: {
  chunkIds: readonly string[];
  answerText: string;
  chunksById: ReadonlyMap<string, DocChildById>;
}): { rows: CitedRow[]; sources: ChatTraceChunk[] } {
  const grounded = new Map<string, DocChildById>();
  for (const id of input.chunkIds) {
    const chunk = input.chunksById.get(id);
    // A gone chunk row resolves to nothing: the invariant is enforced by omission.
    if (!chunk || chunk.textAr.trim() === "") continue;
    for (const label of citationLabelsOf({
      id: chunk.id,
      text: chunk.textAr,
      metadata: chunk.metadata,
    }).map(normalizeCitationLabel)) {
      if (label !== "" && !grounded.has(label)) grounded.set(label, chunk);
    }
  }
  const known = new Set(grounded.keys());
  const rows: CitedRow[] = [];
  for (const span of citationCandidatesIn(input.answerText)) {
    const labels = groundingLabelsFor(span, known);
    if (labels === null) continue;
    // The citation keeps the span as the answer wrote it, backed by the first
    // address that grounds it — for a range, its head verse.
    const chunk = labels
      .map((label) => grounded.get(label))
      .find((candidate): candidate is DocChildById => candidate !== undefined);
    if (chunk === undefined || rows.some((row) => row.label === span)) continue;
    rows.push({ label: span, chunk });
  }
  return { rows, sources: sourcesOf(rows) };
}

/** The cited sources' display rows: one per chunk in citation order, carrying the
 * label the answer wrote and the chunk's title. */
function sourcesOf(rows: readonly CitedRow[]): ChatTraceChunk[] {
  const sources: ChatTraceChunk[] = [];
  for (const row of rows) {
    if (sources.some((source) => source.id === row.chunk.id)) continue;
    const title = row.chunk.parentTitle;
    sources.push({
      id: row.chunk.id,
      label: row.label,
      ...(typeof title === "string" && title.trim() !== "" ? { source: title } : {}),
    });
  }
  return sources;
}
