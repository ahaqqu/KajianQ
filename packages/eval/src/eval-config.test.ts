import { describe, expect, it } from "vitest";
import { EvalConfigError, loadEvalRunConfig } from "./eval-config";

/** A minimal valid binder; tests spread overrides over it. */
const VALID = {
  EVAL_API_BASE_URL: "https://api.example.com",
  EVAL_API_TOKEN: "tok",
  NEON_DATABASE_URL: "postgres://u:p@db.example.com/x",
  EVAL_BUDGET_MICRO_USD: "5000",
};

describe("loadEvalRunConfig (thermo-review B2/A1/A2)", () => {
  it("parses a fully valid env into a typed config", () => {
    const cfg = loadEvalRunConfig(VALID);
    expect(cfg.apiBaseUrl).toBe("https://api.example.com");
    expect(cfg.apiToken).toBe("tok");
    expect(cfg.budgetCapMicroUsd).toBe(5000);
    expect(cfg.goldenSetPath).toBe("packages/kajianq-domain/fixtures/golden-set-v0.json");
    expect(cfg.runLabel).toBeUndefined();
  });

  it("uses the EVAL_GOLDEN_SET_PATH override when set (A2)", () => {
    const cfg = loadEvalRunConfig({ ...VALID, EVAL_GOLDEN_SET_PATH: "/tmp/set.json" });
    expect(cfg.goldenSetPath).toBe("/tmp/set.json");
  });

  it("accepts an explicit 0 cap as the opt-out sentinel", () => {
    const cfg = loadEvalRunConfig({ ...VALID, EVAL_BUDGET_MICRO_USD: "0" });
    expect(cfg.budgetCapMicroUsd).toBe(0);
  });

  it("fails closed on an empty budget value (A1)", () => {
    expect(() => loadEvalRunConfig({ ...VALID, EVAL_BUDGET_MICRO_USD: "   " })).toThrow(
      EvalConfigError,
    );
  });

  it("fails on a non-integer or negative budget", () => {
    expect(() => loadEvalRunConfig({ ...VALID, EVAL_BUDGET_MICRO_USD: "1.5" })).toThrow(
      EvalConfigError,
    );
    expect(() => loadEvalRunConfig({ ...VALID, EVAL_BUDGET_MICRO_USD: "-1" })).toThrow(
      EvalConfigError,
    );
  });

  it("fails naming the missing required variable", () => {
    expect(() => loadEvalRunConfig({})).toThrow(/EVAL_API_BASE_URL is not set/);
    expect(() => loadEvalRunConfig({ EVAL_API_BASE_URL: "https://x.dev" })).toThrow(
      /EVAL_API_TOKEN is not set/,
    );
  });

  it("fails on a malformed or wrong-scheme API base URL", () => {
    expect(() => loadEvalRunConfig({ ...VALID, EVAL_API_BASE_URL: "not a url" })).toThrow(
      EvalConfigError,
    );
    expect(() => loadEvalRunConfig({ ...VALID, EVAL_API_BASE_URL: "ftp://api.dev" })).toThrow(
      /http\(s\) URL/,
    );
  });

  it("accepts a postgres:// Neon connection string (any valid URL scheme)", () => {
    const cfg = loadEvalRunConfig(VALID);
    expect(cfg.neonDatabaseUrl).toBe("postgres://u:p@db.example.com/x");
  });

  it("passes a run label through when set", () => {
    const cfg = loadEvalRunConfig({ ...VALID, EVAL_RUN_LABEL: "nightly" });
    expect(cfg.runLabel).toBe("nightly");
  });
});
