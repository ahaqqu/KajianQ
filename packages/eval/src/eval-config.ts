/**
 * Eval CLI config: the one place `process.env` is read, validated, and typed
 * before the run proceeds — required vars, URL / integer shapes, and the
 * fixture path are all checked up front so a misconfiguration fails before any
 * spend.
 */

/** Validated, typed configuration for one `eval:run` invocation. */
export type EvalRunConfig = {
  /** The staging /v1/chat origin (required, URL-shaped). */
  apiBaseUrl: string;
  /** An anonymous Bearer token minted by the API (required). */
  apiToken: string;
  /** The store connection string the run reads traces from (required). */
  databaseUrl: string;
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

/** Require a set, syntactically-valid URL (any scheme — Postgres is `postgres:`). */
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
 * Default fixture path: the domain pack resolves its own fixture, and callers
 * may point `EVAL_GOLDEN_SET_PATH` anywhere.
 */
function resolveGoldenSetPath(raw: string | undefined): string {
  const configured = raw?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return "packages/kajianq-domain/fixtures/golden-set-v0.json";
}

/**
 * The embedding-benchmark store (issue #9): the sealed samples, the
 * append-only run files, and the generated report live at repo root under
 * `benchmarks/embeddings/` — measurements are versioned repo content, not a
 * file one run overwrites. Same shape as the decision-bench store
 * (`DECISION_BENCH_DEFAULT_DIR`).
 */
export const EMBED_BENCH_DEFAULT_DIR = "benchmarks/embeddings";

/** Default sealed samples: the versioned probe/expansion fixtures. */
export const EMBED_BENCH_DEFAULT_PROBE_PATH = `${EMBED_BENCH_DEFAULT_DIR}/samples/probes.json`;
export const EMBED_BENCH_DEFAULT_EXPANSION_PATH = `${EMBED_BENCH_DEFAULT_DIR}/samples/expansion-cases.json`;

export const EMBED_BENCH_DEFAULT_SEAL_PATH = `${EMBED_BENCH_DEFAULT_DIR}/samples/version.json`;

export const EMBED_BENCH_DEFAULT_RUNS_DIR = `${EMBED_BENCH_DEFAULT_DIR}/runs`;

/** The generated report (offline from the committed files; never hand-edited). */
export const EMBED_BENCH_DEFAULT_REPORT_PATH = `${EMBED_BENCH_DEFAULT_DIR}/report.md`;

/** Validated, typed configuration for one `eval:embed-bench` invocation. */
export type EmbedBenchConfig = {
  /**
   * The store connection string — optional: the gate run is source-based and
   * DB-free, so the URL is only validated for URL-shape when actually provided;
   * undefined otherwise.
   */
  databaseUrl: string | undefined;
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
  /** Store root (samples, runs, report). */
  dir: string;
  /** Probe fixture path. */
  probePath: string;
  /** Expansion fixture path. */
  expansionPath: string;
  /** The samples seal. */
  sealPath: string;
  /** Append-only run files, one per candidate arm. */
  runsDir: string;
  /** Output report path (markdown, derived offline). */
  reportPath: string;
};

/**
 * Parse and validate the embedding-benchmark env. Same binder discipline as
 * `loadEvalRunConfig`: the caller passes the env record; a misconfiguration
 * fails before any spend.
 */
export function loadEmbedBenchConfig(env: Record<string, string | undefined>): EmbedBenchConfig {
  // The benchmark never touches the store, so the URL is optional here
  // (validated for shape only when supplied) — unlike `loadEvalRunConfig`,
  // whose eval-run path reads persisted runs.
  const databaseUrl =
    env.DATABASE_URL !== undefined && env.DATABASE_URL.trim() !== ""
      ? requireUrl("DATABASE_URL", env.DATABASE_URL)
      : undefined;
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
  const dir = env.EMBED_BENCH_DIR?.trim() || EMBED_BENCH_DEFAULT_DIR;
  return {
    databaseUrl,
    budgetCapMicroUsd,
    groupACap: intOrUndefined("BENCH_GROUP_A", env.BENCH_GROUP_A),
    groupBCap: intOrUndefined("BENCH_GROUP_B", env.BENCH_GROUP_B),
    docBudget: intOrUndefined("BENCH_DOC_BUDGET", env.BENCH_DOC_BUDGET),
    batchSize: intOrUndefined("BENCH_BATCH_SIZE", env.BENCH_BATCH_SIZE),
    dir,
    probePath: env.BENCH_PROBE_PATH?.trim() || `${dir}/samples/probes.json`,
    expansionPath: env.BENCH_EXPANSION_PATH?.trim() || `${dir}/samples/expansion-cases.json`,
    sealPath: `${dir}/samples/version.json`,
    runsDir: `${dir}/runs`,
    reportPath: env.BENCH_REPORT_PATH?.trim() || `${dir}/report.md`,
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
  const databaseUrl = requireUrl("DATABASE_URL", env.DATABASE_URL);
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
    databaseUrl,
    budgetCapMicroUsd,
    runLabel: env.EVAL_RUN_LABEL?.trim() || undefined,
    goldenSetPath: resolveGoldenSetPath(env.EVAL_GOLDEN_SET_PATH),
  };
}

/**
 * Default fixture path for the independent probe suite. It is its own file, never
 * a Golden Set: the suite applies no coverage floors and writes no ledger row.
 */
export const INDEPENDENT_PROBES_DEFAULT_PATH =
  "packages/kajianq-domain/fixtures/independent-probes-v1.json";

/** Validated, typed configuration for one `eval:probes` invocation. The suite reads
 * no ledger and scores from the answer it receives, so it needs no DATABASE_URL. */
export type EvalProbeConfig = {
  apiBaseUrl: string;
  apiToken: string;
  probePath: string;
};

/**
 * Parse and validate the independent-probe env. Same binder discipline as
 * `loadEvalRunConfig`, minus the store: the run asks its fixed questions and
 * persists nothing, so a missing DATABASE_URL is not a misconfiguration here.
 */
export function loadEvalProbeConfig(env: Record<string, string | undefined>): EvalProbeConfig {
  return {
    apiBaseUrl: requireHttpUrl("EVAL_API_BASE_URL", env.EVAL_API_BASE_URL),
    apiToken: requireToken("EVAL_API_TOKEN", env.EVAL_API_TOKEN),
    probePath: env.EVAL_PROBE_FIXTURE_PATH?.trim() || INDEPENDENT_PROBES_DEFAULT_PATH,
  };
}
