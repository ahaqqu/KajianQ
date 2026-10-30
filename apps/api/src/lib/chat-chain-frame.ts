import type { ChatChain, ChatTraceChain, Trace, TraceEvent } from "@app/contracts";
import type { NarratorIdsLookup, RagStore } from "@app/infra";
import type { StoreBridge } from "@app/kajianq-domain";
import type { Warn } from "./chat-trace";

/**
 * The per-chain half of the two user-facing frames: everything the citation sheet
 * and the Trace panel know about a passage's transmission rows.
 *
 * **The record is the persisted trace, not a fresh read.** Rows come from the
 * answer's own `chain_evidence` event, projected in the event's order and never
 * re-read from the store — the same posture the citations and trace frames take
 * for chunks (ADR-0007). The one store join is the narrator's display spelling,
 * resolved by the ids the event recorded, exactly as a chunk's title is.
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
  /** Whether the read bounded any child's list. */
  moreMayExist: boolean;
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
  let moreMayExist = false;
  for (const event of events) {
    for (const child of event.detail.children) {
      byChild.set(child.childId, child);
      if (child.moreMayExist === true) moreMayExist = true;
      for (const chain of child.chains) {
        for (const id of chain.narratorIds) {
          if (!narratorIds.includes(id)) narratorIds.push(id);
        }
      }
    }
  }
  return { byChild, moreMayExist, narratorIds };
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

/**
 * The chains a cited child's rows carry, or `undefined` when the trace recorded
 * no evidence for it. Projected verbatim — every row, in the recorded order — so
 * the sheet cannot present one grade for a passage whose chains disagree.
 */
export function citationChainsFor(
  childId: string,
  evidence: RecordedEvidence | null,
  names: NarratorNames,
): ChatChain[] | undefined {
  const recorded = evidence?.byChild.get(childId);
  if (recorded === undefined) return undefined;
  return recorded.chains.map((chain) => ({
    ...toCitationChain(chain, names),
    ...(recorded.moreMayExist === true ? { moreMayExist: true } : {}),
  }));
}

/**
 * The Trace panel's chains-consulted block, or `undefined` when the run recorded no
 * read. An EMPTY list is a recorded read that found no row, which the panel says
 * in its own words rather than showing nothing.
 */
export function traceChainsOf(
  evidence: RecordedEvidence | null,
  names: NarratorNames,
): ChatTraceChain[] | undefined {
  if (evidence === null) return undefined;
  return [...evidence.byChild.values()].map((child) => ({
    childId: child.childId,
    chains: child.chains.map((chain) => toCitationChain(chain, names)),
    ...(child.moreMayExist === true ? { moreMayExist: true } : {}),
  }));
}
