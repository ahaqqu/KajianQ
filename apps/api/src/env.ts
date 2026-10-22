import type { AssetFetcher } from "@app/hardening";
import type { Logger, RagStore } from "@app/infra";

export type AppEnvName = "development" | "staging" | "production";

/** Per-request context built once in middleware and threaded through `c.var`. */
export type RequestContext = {
  logger: Logger;
  envName: AppEnvName;
  correlationId: string;
};

/**
 * The environment the Hono app is handed once per request: plain configuration built
 * at the composition root (`lib/server.ts`). Nothing host-specific remains — the rate
 * limiter is the package's process-global in-memory backend, and raw-corpus archival
 * is a CLI concern, never a serving path.
 */
export type AppBindings = {
  ASSETS: AssetFetcher;
  APP_ENV?: string;
  /** Postgres connection string — the RagStore adapter's backing store. */
  DATABASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
  /** Provider API keys, bound by name from `models.json`'s `apiKeyEnv` entries. The
   * wiring reads keys only through `resolveRole`'s env record — never vendor names. */
  GEMINI_API_KEY?: string;
  /** Paid-terms Gemini row (same API, billing-enabled project). */
  GEMINI_PAID_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  /** The switchable chat vendor's key: required only by a profile that routes a
   * serving role to its row. With such a profile selected and this key absent, the
   * role fails with a typed provider error naming this variable — never a silent
   * route to another vendor. */
  OLLAMA_API_KEY?: string;
  /** The decision vendor's key: binds the reviewer pre-gate. Optional — an absent key
   * leaves the reviewer unchanged, because the pre-gate only ever removes spend
   * (fail-open). */
  JEV_API_KEY?: string;
  /** The named provider profile from `models.json`'s `profiles` block. Absent,
   * empty, or `default` = the checked-in default chains, so unsetting this variable
   * is the rollback. Any other value must name a declared profile; an unknown name
   * is a typed config failure when the chat wiring builds (at boot the provider
   * posture report fails the process), never a silent default. */
  PROVIDER_PROFILE?: string;
  /** The scope-expansion budget both triggers share — the surah the question names
   * and the short surah a retrieved verse completes — as a non-negative integer
   * string. Absent = the domain default; `0` disables both. Config, never a secret,
   * but it rides the same filtered env view so the knob reaches the pipeline's wiring. */
  SCOPE_EXPANSION_CAP?: string;
  /** The retrieved-verse neighbourhood expansion, as non-negative integer strings: how
   * many ordinals on each side of a retrieved verse join the context, and how many chunks
   * the expansion may add to one query. Absent = the domain defaults; `0` disables the
   * expansion and a negative value is a typed config failure when the chat wiring builds
   * — every `/v1/chat` request answers 503 while the process itself still boots — not a
   * second spelling of "off". They ride the same filtered env view as the scope cap. */
  NEIGHBOUR_EXPANSION_RADIUS?: string;
  NEIGHBOUR_EXPANSION_CAP?: string;
  /** The citation-label lookup's budget, as a non-negative integer string: how many
   * chunks a question's own `HR. … no. N` / `QS. n:m` labels may add. Absent = the
   * domain default; `0` disables the lookup, and a negative value is a typed config
   * failure when the chat wiring builds. Same filtered-env view as the caps above. */
  LABEL_LOOKUP_CAP?: string;
};

/** Resolved per-request identity, set by `authGuard` before guarded routes run; session
 * persistence lives behind the RagStore seam. */
export type Authed = { store: RagStore; userId: string };

export type ApiEnv = {
  Bindings: AppBindings;
  Variables: { correlationId: string; ctx: RequestContext; authed: Authed };
};

export type { RateLimiter } from "@app/rate";

export function resolveEnvName(raw: string | undefined): AppEnvName {
  if (raw === "staging" || raw === "production" || raw === "development") {
    return raw;
  }
  return "development";
}

export function allowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
