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
 * **What this owns, and why it is not just "drop the filters".** Emptying the
 * whole filter record on the first zero-hit search is a widening the trace
 * cannot describe: a wrong text-layer hint takes a grade screen down with it,
 * so a question routed to strong-grade evidence silently comes back over weak
 * material too — and one event naming the whole set reads identically whether
 * one hint was wrong or all of them were.
 *
 * So a zero-hit search **probes** the dimensions in a declared order: each probe
 * omits exactly one dimension, and only a probe that returns hits is *adopted*
 * (kept for the rest of the run). A probe that changes nothing is recorded and
 * discarded, leaving the route's own record intact. That costs no more searches
 * than relaxing the whole record at once — a blind retry also runs until
 * something matches, but it cannot tell a satisfiable hint from an unsatisfiable
 * one. A reader reconstructs the record any search ran with as
 * `intended − every ADOPTED drop`.
 *
 * **One diagnosis per run** (`settle`). The hints come from the routing decision,
 * which is a property of the request rather than of one sub-query's embedding, so
 * a sweep already made holds for the searches after it — a request the filters
 * cannot serve pays for the probing once, not once per sub-query per track.
 *
 * **The record-level last resort.** A per-dimension probe can only help when
 * *exactly one* dimension is unsatisfiable: with two, every probe still carries
 * the other and every probe returns nothing. Two dead dimensions are the
 * expected state today, not a corner case — no row carries `madzhab`,
 * `textLayer` or `principleTags`, and the router prompt offers all three as
 * hints. So when the sweep exhausts with nothing adopted, the policy hands out
 * **one more** probe that omits every live dimension at once: the retry runs
 * with `{}`, and the earlier `adopted: false` probes stay on the trace as the
 * evidence that no single dimension was at fault. Without it a wrong hint turns
 * into a refusal for a question the corpus can serve.
 *
 * **The last resort runs a record nothing has run yet, or it does not run.**
 * It is issued only with two or more live dimensions. One live dimension's own
 * probe already ran `{}` (its `retained` is empty), and with none the run's
 * first search ran it, so repeating it there would be a byte-identical search
 * and a duplicate `filter_relaxed` event — and would break the discriminator
 * the trace reads by (`trace-events.ts`: an event naming *every* live dimension
 * is the last resort), which is indistinguishable from a lone dimension's probe
 * when only that one was live.
 */
export type FilterRelaxation = {
  /** The record the next search should run with. */
  active(): Record<string, string[]>;
  /**
   * The next probe to run for a zero-hit search — the dimensions to omit and the
   * record to omit them from — or `undefined` once there is nothing left to try.
   * One dimension for a per-dimension probe; every live dimension for the
   * record-level last resort.
   */
  next(): { dropped: readonly FilterEntry[]; retained: Record<string, string[]> } | undefined;
  /** Keep a drop for the rest of the run, because its probe found hits. */
  adopt(dropped: readonly FilterEntry[]): void;
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
      if (drop !== undefined) {
        tried.push(drop);
        return { dropped: [drop], retained: record(live.filter((entry) => entry !== drop)) };
      }
      // Every dimension in play survived its own probe, so the record as a SET
      // matched nothing. Reaching here means no untried live dimension is left,
      // so a lone live dimension's own probe has already run exactly `{}` (and
      // with none, the run's first search did): firing again would repeat a
      // byte-identical search, record a duplicate `filter_relaxed` event, and
      // leave the trace unable to tell a lone dimension's probe from the last
      // resort.
      settled = true;
      if (live.length <= 1) return undefined;
      return { dropped: [...live], retained: record([]) };
    },
    adopt: (dropped) => {
      live = live.filter((entry) => !dropped.includes(entry));
      settled = true;
    },
    settle: () => {
      settled = true;
    },
  };
}
