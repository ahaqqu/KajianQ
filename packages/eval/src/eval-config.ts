/**
 * Eval CLI config (#8, thermo-review B2/A2): the one place `process.env` is
 * read, validated, and typed before the run proceeds — required vars, URL /
 * integer shapes, and the fixture path are all checked up front so a
 * misconfiguration fails before any spend.
 */

/** Validated, typed configuration for one `eval:run` invocation. */
export type EvalRunConfig = {
  /** The staging /v1/chat origin (required, URL-shaped). */
  apiBaseUrl: string;
  /** An anonymous Bearer token minted by the API (required). */
  apiToken: string;
  /** The staging Neon store connection string (required). */
  neonDatabaseUrl: string;
  /** Hard spend cap in micro-USD (fail-closed: unset/0 = explicit opt-out). */
  budgetCapMicroUsd: number | undefined;
  /** Optional persisted run label. */
  runLabel: string | undefined;
  /** Absolute or cwd-relative path of the Golden Set fixture JSON. */
  goldenSetPath: string;
};

/** Thrown when the env is misconfigured; the CLI maps it to a fail-fast exit. */
export class EvalConfigError extends Error {}

/** Require a set, URL-shaped value with an http(s) scheme (the chat API origin). */
function requireHttpUrl(name: string, raw: string | undefined): string {
  const url = requireUrl(name, raw);
  const scheme = new URL(url).protocol;
  if (scheme !== "http:" && scheme !== "https:") {
    throw new EvalConfigError(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return url;
}

/** Require a set, syntactically-valid URL (any scheme — Neon is `postgres:`). */
function requireUrl(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new EvalConfigError(`${name} is not set`);
  }
  try {
    new URL(raw);
  } catch {
    throw new EvalConfigError(`${name} must be a valid URL, got "${raw}"`);
  }
  return raw;
}

function requireToken(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new EvalConfigError(`${name} is not set`);
  }
  return raw;
}

/**
 * Default fixture path: the domain pack resolves its own fixture (A2 — the
 * CLI no longer hard-codes a cross-package relative URL); callers may point
 * `EVAL_GOLDEN_SET_PATH` anywhere.
 */
function resolveGoldenSetPath(raw: string | undefined): string {
  const configured = raw?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return "packages/kajianq-domain/fixtures/golden-set-v0.json";
}

/**
 * The default fixtures the benchmark CLI reads (overridable so a re-run can
 * point at a new versioned set): the #9 probe/expansion pairs the domain
 * pack authored against the real corpus.
 */
export const EMBED_BENCH_DEFAULT_PROBE_PATH =
  "packages/kajianq-domain/fixtures/embed-bench-probes-v0.json";
export const EMBED_BENCH_DEFAULT_EXPANSION_PATH =
  "packages/kajianq-domain/fixtures/expansion-cases-v0.json";

/** Validated, typed configuration for one `eval:embed-bench` invocation. */
export type EmbedBenchConfig = {
  /** The staging Neon store connection string (required). */
  neonDatabaseUrl: string;
  /** Hard spend cap in micro-USD (unset/0 = explicit opt-out). */
  budgetCapMicroUsd: number | undefined;
  /** Cap on the corpus's first source group (undefined = the domain's full set). */
  groupACap: number | undefined;
  /** Cap on the corpus's second source group (undefined = the domain's full set). */
  groupBCap: number | undefined;
  /**
   * Total doc budget across groups (undefined = full corpus). The gate's
   * free-tier item budget — embedded items count against the vendor's
   * per-minute embed-content cap, so a bounded stratified subset is the
   * practical gate corpus.
   */
  docBudget: number | undefined;
  /** Embedding batch size (default 96; lower it under tight item quotas). */
  batchSize: number | undefined;
  /** Probe fixture path. */
  probePath: string;
  /** Expansion fixture path. */
  expansionPath: string;
  /** Output report path (JSON, defaults next to the fixtures). */
  reportPath: string;
};

/**
 * Parse and validate the embedding-benchmark env. Same binder discipline as
 * `loadEvalRunConfig`: the caller passes the env record; a misconfiguration
 * fails before any spend.
 */
export function loadEmbedBenchConfig(env: Record<string, string | undefined>): EmbedBenchConfig {
  const neonDatabaseUrl = requireUrl("NEON_DATABASE_URL", env.NEON_DATABASE_URL);
  const rawCap = env.EVAL_BUDGET_MICRO_USD;
  let budgetCapMicroUsd: number | undefined;
  if (rawCap !== undefined) {
    const n = Number(rawCap.trim() === "" ? Number.NaN : rawCap);
    if (!Number.isInteger(n) || n < 0) {
      throw new EvalConfigError(
        `EVAL_BUDGET_MICRO_USD must be a non-negative integer (0 = explicit opt-out), got "${rawCap}"`,
      );
    }
    budgetCapMicroUsd = n;
  }
  const intOrUndefined = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new EvalConfigError(`${name} must be a non-negative integer, got "${raw}"`);
    }
    return n;
  };
  return {
    neonDatabaseUrl,
    budgetCapMicroUsd,
    groupACap: intOrUndefined("BENCH_GROUP_A", env.BENCH_GROUP_A),
    groupBCap: intOrUndefined("BENCH_GROUP_B", env.BENCH_GROUP_B),
    docBudget: intOrUndefined("BENCH_DOC_BUDGET", env.BENCH_DOC_BUDGET),
    batchSize: intOrUndefined("BENCH_BATCH_SIZE", env.BENCH_BATCH_SIZE),
    probePath: env.BENCH_PROBE_PATH?.trim() || EMBED_BENCH_DEFAULT_PROBE_PATH,
    expansionPath: env.BENCH_EXPANSION_PATH?.trim() || EMBED_BENCH_DEFAULT_EXPANSION_PATH,
    reportPath:
      env.BENCH_REPORT_PATH?.trim() || "packages/kajianq-domain/fixtures/embed-bench-results.json",
  };
}

/**
 * Parse and validate the eval run env (the binder — `process.env` on the
 * CLI, a fixture object in tests — is passed in: an engine module never
 * reaches for the ambient `process`). Throws `EvalConfigError` naming the
 * first misconfigured variable; never returns a partially-valid config.
 */
export function loadEvalRunConfig(env: Record<string, string | undefined>): EvalRunConfig {
  const apiBaseUrl = requireHttpUrl("EVAL_API_BASE_URL", env.EVAL_API_BASE_URL);
  const apiToken = requireToken("EVAL_API_TOKEN", env.EVAL_API_TOKEN);
  const neonDatabaseUrl = requireUrl("NEON_DATABASE_URL", env.NEON_DATABASE_URL);
  const rawCap = env.EVAL_BUDGET_MICRO_USD;
  let budgetCapMicroUsd: number | undefined;
  if (rawCap !== undefined) {
    const n = Number(rawCap.trim() === "" ? Number.NaN : rawCap);
    if (!Number.isInteger(n) || n < 0) {
      throw new EvalConfigError(
        `EVAL_BUDGET_MICRO_USD must be a non-negative integer (0 = explicit opt-out), got "${rawCap}"`,
      );
    }
    budgetCapMicroUsd = n;
  }
  return {
    apiBaseUrl,
    apiToken,
    neonDatabaseUrl,
    budgetCapMicroUsd,
    runLabel: env.EVAL_RUN_LABEL?.trim() || undefined,
    goldenSetPath: resolveGoldenSetPath(env.EVAL_GOLDEN_SET_PATH),
  };
}
