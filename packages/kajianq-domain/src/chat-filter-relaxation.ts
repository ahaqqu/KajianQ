import { nextRelaxation, type FilterEntry } from "./chat-filter-policy";

/**
 * **Filter relaxation policy** — Smart Router stage 3's safety valve, as a
 * unit-testable object with no store and no effects.
 *
 * The router's filters are hints a cheap model inferred, and it does not
 * reliably leave unconstrained attributes empty (observed: a Quran question
 * routed with a text-layer hint no Quran chunk carries), so a hint that
 * matches nothing empties the context and makes the answer uncitable. The
 * retriever therefore gives a hint up and retries.
 *
 * **What this owns, and why it is not just "drop the filters".** The previous
 * policy emptied the whole filter record on the first zero-hit search, which is
 * a widening the trace could not describe: a wrong text-layer hint took a grade
 * screen down with it, so a question routed to strong-grade evidence silently
 * came back over weak material too — and one event naming the whole set read
 * identically whether one hint was wrong or all of them were.
 *
 * So a zero-hit search **probes** the dimensions in a declared order: each probe
 * omits exactly one dimension, and only a probe that returns hits is *adopted*
 * (kept for the rest of the run). A probe that changes nothing is recorded and
 * discarded, leaving the route's own record intact. That costs no more searches
 * than relaxing blindly did — the blind version also retried until something
 * matched, it just could not tell a satisfiable hint from an unsatisfiable one.
 * A reader reconstructs the record any search ran with as
 * `intended − every ADOPTED drop`.
 *
 * **One diagnosis per run** (`settle`). The hints come from the routing decision,
 * which is a property of the request rather than of one sub-query's embedding, so
 * a sweep already made holds for the searches after it — a request the filters
 * cannot serve pays for the probing once, not once per sub-query per track.
 */
export type FilterRelaxation = {
  /** The record the next search should run with. */
  active(): Record<string, string[]>;
  /**
   * The next probe to run for a zero-hit search — the dimension to omit and the
   * record to omit it from — or `undefined` once there is nothing left to try.
   */
  next(): { drop: FilterEntry; retained: Record<string, string[]> } | undefined;
  /** Keep a drop for the rest of the run, because its probe found hits. */
  adopt(drop: FilterEntry): void;
  /** This search is over: stop probing for the remainder of the run. */
  settle(): void;
  /** Whether a zero-hit search may still probe. */
  probing(): boolean;
};

export function createFilterRelaxation(intended: readonly FilterEntry[]): FilterRelaxation {
  let live: readonly FilterEntry[] = intended;
  const tried: FilterEntry[] = [];
  let settled = false;

  const record = (entries: readonly FilterEntry[]): Record<string, string[]> =>
    Object.fromEntries(entries.map((entry) => [entry.key, [...entry.values]]));

  return {
    active: () => record(live),
    probing: () => !settled,
    next: () => {
      if (settled) return undefined;
      const drop = nextRelaxation(live.filter((entry) => !tried.includes(entry)));
      if (drop === undefined) {
        settled = true;
        return undefined;
      }
      tried.push(drop);
      return { drop, retained: record(live.filter((entry) => entry !== drop)) };
    },
    adopt: (drop) => {
      live = live.filter((entry) => entry !== drop);
      settled = true;
    },
    settle: () => {
      settled = true;
    },
  };
}
