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
 * **`0` is the documented disable while a negative value is malformed config** —
 * `-1` is not a second spelling of "off". The failure is raised when the chat
 * wiring builds, which the chat route does **per request**, so the process boots
 * green and every `/v1/chat` request answers 503.
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

/** `SCOPE_EXPANSION_CAP`: children of a named surah the scope expansion may add. */
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
