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
