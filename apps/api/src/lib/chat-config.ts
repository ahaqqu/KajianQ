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
