import { CALLER_PRIORITY_K, CHAIN_EVIDENCE_TRACE_LIMIT } from "@app/contracts";
import { resolvePostgresStore, type RagStore } from "@app/infra";

/** The chat wiring's configuration surface: the typed config failure, the store
 * construction from `DATABASE_URL`, and the scope-expansion budget parser.
 * `chat-wiring.ts` re-exports every name here, so callers keep importing the wiring
 * module. */

/** A misconfigured chat wiring: typed so the route maps configuration failures to
 * 503 while anything else falls through to the app's typed error handler. */
export class ChatConfigError extends Error {
  readonly missing?: string;
  constructor(msg: string, missing?: string) {
    super(msg);
    this.name = "ChatConfigError";
    if (missing !== undefined) this.missing = missing;
  }
}

/**
 * Build the RagStore from the `DATABASE_URL` binding; a missing binding throws the
 * typed `ChatConfigError` (the route answers 503 rather than silently degrading),
 * while anything else propagates to the typed error handler. The URL goes to the
 * adapter's own composition helper, so the app never imports a database client.
 */
export function createRagStoreFromEnv(env: { DATABASE_URL?: string }): RagStore {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new ChatConfigError("chat route: DATABASE_URL is not bound", "DATABASE_URL");
  }
  return resolvePostgresStore(url);
}

/**
 * The one parser behind every bounded retrieval knob: absent/empty = the domain
 * default, a malformed value is a typed config failure naming the variable, and
 * **`0` is the documented disable unless a caller narrows the range** — `-1` is
 * not a second spelling of "off". The per-chain row budget refuses 0 because
 * carrying no row would flatten a chain-bearing passage. The failure is raised
 * when the chat wiring builds, which the chat route does **per request**, so the
 * process boots green and every `/v1/chat` request answers 503.
 */
function parseBoundedKnob(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChatConfigError(
      `chat route: ${name} must be a non-negative integer (got "${raw}"); 0 disables the path`,
      name,
    );
  }
  return value;
}

/** `SCOPE_EXPANSION_CAP`: children the surah reads may add — the surah the question
 * names and a retrieved verse's short surah share the budget. */
export function parseScopeExpansionCap(raw: string | undefined): number | undefined {
  return parseBoundedKnob(raw, "SCOPE_EXPANSION_CAP");
}

/** `NEIGHBOUR_EXPANSION_RADIUS`: ordinals on each side of a retrieved verse. */
export function parseNeighbourRadius(raw: string | undefined): number | undefined {
  return parseBoundedKnob(raw, "NEIGHBOUR_EXPANSION_RADIUS");
}

/** `NEIGHBOUR_EXPANSION_CAP`: chunks the neighbourhood expansion may add. */
export function parseNeighbourCap(raw: string | undefined): number | undefined {
  return parseBoundedKnob(raw, "NEIGHBOUR_EXPANSION_CAP");
}

/** `LABEL_LOOKUP_CAP`: chunks the citation-label lookup may add per query. */
export function parseLabelLookupCap(raw: string | undefined): number | undefined {
  return parseBoundedKnob(raw, "LABEL_LOOKUP_CAP");
}

/**
 * `CHAIN_EVIDENCE_CHILD_CAP`: retrieved children whose transmission rows the
 * per-chain evidence read covers. `0` reads none and records every
 * chain-bearing child as unread; the citations and Trace say so instead of
 * falling back to a flattened grade.
 */
export function parseChainEvidenceChildCap(raw: string | undefined): number | undefined {
  return parseBoundedKnob(raw, "CHAIN_EVIDENCE_CHILD_CAP");
}

/**
 * `CHAIN_EVIDENCE_CHAIN_CAP`: rows carried per child. The value is bounded on both
 * sides and refused here rather than at read or write time: a cap above the trace
 * contract's limit cannot persist a longer list (the answer's trace parse would
 * fail), and `0` would carry no row for a child the read consulted — the child and
 * its `moreMayExist` would be lost, leaving the citation to fall back to the
 * flattened grade. Disabling the read entirely is `CHAIN_EVIDENCE_CHILD_CAP=0`'s
 * job, not this knob's.
 */
export function parseChainEvidenceChainCap(raw: string | undefined): number | undefined {
  const value = parseBoundedKnob(raw, "CHAIN_EVIDENCE_CHAIN_CAP");
  if (value === 0) {
    throw new ChatConfigError(
      `chat route: CHAIN_EVIDENCE_CHAIN_CAP must be at least 1 (got "${raw}"); 0 would carry no row and flatten a chain-bearing passage — set CHAIN_EVIDENCE_CHILD_CAP=0 to disable the read`,
      "CHAIN_EVIDENCE_CHAIN_CAP",
    );
  }
  if (value !== undefined && value > CHAIN_EVIDENCE_TRACE_LIMIT) {
    throw new ChatConfigError(
      `chat route: CHAIN_EVIDENCE_CHAIN_CAP must not exceed the trace's bound of ${CHAIN_EVIDENCE_TRACE_LIMIT} (got "${raw}")`,
      "CHAIN_EVIDENCE_CHAIN_CAP",
    );
  }
  return value;
}

/**
 * `CALLER_PRIORITY_K`: how many of the caller sub-query's leading hits the
 * caller-priority guarantee promotes. It takes the bounded-knob rule — absent
 * means the domain default, `0` disables the guarantee, a malformed value is a
 * typed config failure — plus one bound of its own: the contract's
 * `caller_priority` record refuses more ids than `CALLER_PRIORITY_K`, so a
 * configured value above it fails here, at wiring time, rather than writing a
 * trace that cannot be parsed back for every answer the box serves.
 */
export function parseCallerPriorityK(raw: string | undefined): number | undefined {
  const value = parseBoundedKnob(raw, "CALLER_PRIORITY_K");
  if (value !== undefined && value > CALLER_PRIORITY_K) {
    throw new ChatConfigError(
      `chat route: CALLER_PRIORITY_K must not exceed the trace's bound of ${CALLER_PRIORITY_K} (got "${raw}")`,
      "CALLER_PRIORITY_K",
    );
  }
  return value;
}
