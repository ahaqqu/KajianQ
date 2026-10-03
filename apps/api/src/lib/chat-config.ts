import { resolvePostgresStore, type RagStore } from "@app/infra";

/**
 * The chat wiring's configuration surface (#10, ADR-0045): the typed config
 * failure, the store construction from the `DATABASE_URL` binding, and the
 * scope-expansion budget parser. Split out of `chat-wiring.ts` to respect the
 * agentic 300-line cap — the same pattern the `RagStore` seams use in
 * `packages/infra`. `chat-wiring.ts` re-exports every name here, so the API's
 * import surface is unchanged.
 */

/**
 * A misconfigured chat wiring (thermo-review A7): typed so the route maps
 * configuration failures to 503 while anything else falls through to the
 * app's typed error handler — a bare `Error` + catch-all 503 used to mask
 * adapter bugs as "not configured".
 */
export class ChatConfigError extends Error {
  readonly missing?: string;
  constructor(msg: string, missing?: string) {
    super(msg);
    this.name = "ChatConfigError";
    if (missing !== undefined) this.missing = missing;
  }
}

/**
 * Build the RagStore from the `DATABASE_URL` binding. Throws a typed
 * `ChatConfigError` (config-class) when the binding is missing — the route
 * answers 503 rather than silently degrading; anything else propagates to
 * the typed error handler.
 *
 * The URL is passed to the adapter's own composition helper: the app names the
 * connection and receives the seam, and never imports a database client
 * (ADR-0008 — the driver lives behind the adapter, ADR-0044).
 */
export function createRagStoreFromEnv(env: { DATABASE_URL?: string }): RagStore {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new ChatConfigError("chat route: DATABASE_URL is not bound", "DATABASE_URL");
  }
  return resolvePostgresStore(url);
}

/**
 * Parse ADR-0045's scope-expansion budget from the environment. Absent/empty
 * is "use the domain default"; `0` disables expansion; anything that is not a
 * non-negative integer is a typed config failure, so a typo in deployment
 * config cannot silently leave the cap at a value the operator did not choose.
 */
export function parseScopeExpansionCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChatConfigError(
      `chat route: SCOPE_EXPANSION_CAP must be a non-negative integer (got "${raw}")`,
      "SCOPE_EXPANSION_CAP",
    );
  }
  return value;
}

/**
 * The one parser behind ADR-0049's two neighbourhood knobs — the radius and
 * the chunk cap. They share a shape and a failure mode, so they share the rule
 * (absent/empty = the domain default; a malformed value is a typed config
 * failure naming the variable, never a silent default). Both are read at the
 * composition root like every other deployment choice.
 *
 * **`0` is the documented disable; a negative value is malformed config**
 * (review B3 of the #274 fix round; R2 corrected the timing). The domain
 * module and the store adapter short-circuit `<= 0` defensively, but these two
 * variables are what an operator sets, and "`<= 0` disables" told an operator
 * that `-1` was a legal way to turn the expansion off — it is a
 * `ChatConfigError` that leaves the chat route unusable. It is raised when the
 * chat wiring builds, which `apps/api/src/routes/chat.ts` does **per request**
 * (`wiringOr503`), so the process boots green and every `/v1/chat` request
 * answers 503: a config fault an operator sees in per-request logs, not a
 * failed boot (`server.ts` uses "boot" for faults outside the wiring). The
 * parser and the operator-facing docs now say the same thing; accepting
 * negatives would only add a second, undocumented spelling of "off".
 */
function parseNeighbourKnob(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChatConfigError(
      `chat route: ${name} must be a non-negative integer (got "${raw}"); 0 disables the expansion`,
      name,
    );
  }
  return value;
}

/** `NEIGHBOUR_EXPANSION_RADIUS` (ADR-0049): ordinals on each side of a verse. */
export function parseNeighbourRadius(raw: string | undefined): number | undefined {
  return parseNeighbourKnob(raw, "NEIGHBOUR_EXPANSION_RADIUS");
}

/** `NEIGHBOUR_EXPANSION_CAP` (ADR-0049): chunks the expansion may add. */
export function parseNeighbourCap(raw: string | undefined): number | undefined {
  return parseNeighbourKnob(raw, "NEIGHBOUR_EXPANSION_CAP");
}
