import { describe, expect, it } from "vitest";
import { EvalConfigError, loadEmbedBenchConfig } from "./eval-config";

describe("loadEmbedBenchConfig", () => {
  const base = {
    NEON_DATABASE_URL: "postgres://user:pass@host/db",
  };

  it("parses defaults with no optional vars set", () => {
    const config = loadEmbedBenchConfig(base);
    expect(config.neonDatabaseUrl).toBe(base.NEON_DATABASE_URL);
    expect(config.budgetCapMicroUsd).toBeUndefined();
    expect(config.groupACap).toBeUndefined();
    expect(config.groupBCap).toBeUndefined();
    expect(config.probePath).toContain("embed-bench-probes-v0.json");
    expect(config.expansionPath).toContain("expansion-cases-v0.json");
  });

  // Thermo B5: the benchmark is DB-free — the URL is optional; a supplied
  // value is still validated for URL shape.
  it("treats the Neon URL as optional (DB-free run) but validates its shape when set", () => {
    expect(loadEmbedBenchConfig({}).neonDatabaseUrl).toBeUndefined();
    expect(loadEmbedBenchConfig({ NEON_DATABASE_URL: "  " }).neonDatabaseUrl).toBeUndefined();
    expect(() => loadEmbedBenchConfig({ NEON_DATABASE_URL: "not a url" })).toThrow(EvalConfigError);
    expect(loadEmbedBenchConfig(base).neonDatabaseUrl).toBe(base.NEON_DATABASE_URL);
  });

  it("accepts 0 as an explicit opt-out budget but rejects negatives", () => {
    expect(loadEmbedBenchConfig({ ...base, EVAL_BUDGET_MICRO_USD: "0" }).budgetCapMicroUsd).toBe(0);
    expect(() => loadEmbedBenchConfig({ ...base, EVAL_BUDGET_MICRO_USD: "-1" })).toThrow(
      EvalConfigError,
    );
    expect(() => loadEmbedBenchConfig({ ...base, EVAL_BUDGET_MICRO_USD: "1.5" })).toThrow(
      EvalConfigError,
    );
    expect(() => loadEmbedBenchConfig({ ...base, EVAL_BUDGET_MICRO_USD: "" })).toThrow(
      EvalConfigError,
    );
  });

  it("validates corpus caps as non-negative integers", () => {
    expect(loadEmbedBenchConfig({ ...base, BENCH_GROUP_A: "5" }).groupACap).toBe(5);
    expect(() => loadEmbedBenchConfig({ ...base, BENCH_GROUP_A: "x" })).toThrow(EvalConfigError);
    expect(() => loadEmbedBenchConfig({ ...base, BENCH_GROUP_B: "-2" })).toThrow(EvalConfigError);
  });

  it("honors fixture/report path overrides", () => {
    const config = loadEmbedBenchConfig({
      ...base,
      BENCH_PROBE_PATH: "custom/probes.json",
      BENCH_EXPANSION_PATH: "custom/exp.json",
      BENCH_REPORT_PATH: "custom/report.json",
    });
    expect(config.probePath).toBe("custom/probes.json");
    expect(config.expansionPath).toBe("custom/exp.json");
    expect(config.reportPath).toBe("custom/report.json");
  });
});
