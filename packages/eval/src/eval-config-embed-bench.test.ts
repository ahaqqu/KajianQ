import { describe, expect, it } from "vite-plus/test";
import { EvalConfigError, loadEmbedBenchConfig } from "./eval-config";

describe("loadEmbedBenchConfig", () => {
  const base = {
    DATABASE_URL: "postgres://user:pass@host/db",
  };

  it("parses defaults with no optional vars set", () => {
    const config = loadEmbedBenchConfig(base);
    expect(config.databaseUrl).toBe(base.DATABASE_URL);
    expect(config.budgetCapMicroUsd).toBeUndefined();
    expect(config.groupACap).toBeUndefined();
    expect(config.groupBCap).toBeUndefined();
    expect(config.dir).toBe("benchmarks/embeddings");
    expect(config.probePath).toBe("benchmarks/embeddings/samples/probes.json");
    expect(config.expansionPath).toBe("benchmarks/embeddings/samples/expansion-cases.json");
    expect(config.sealPath).toBe("benchmarks/embeddings/samples/version.json");
    expect(config.runsDir).toBe("benchmarks/embeddings/runs");
    expect(config.reportPath).toBe("benchmarks/embeddings/report.md");
  });

  // Thermo B5: the benchmark is DB-free — the URL is optional; a supplied
  // value is still validated for URL shape.
  it("treats the Neon URL as optional (DB-free run) but validates its shape when set", () => {
    expect(loadEmbedBenchConfig({}).databaseUrl).toBeUndefined();
    expect(loadEmbedBenchConfig({ DATABASE_URL: "  " }).databaseUrl).toBeUndefined();
    expect(() => loadEmbedBenchConfig({ DATABASE_URL: "not a url" })).toThrow(EvalConfigError);
    expect(loadEmbedBenchConfig(base).databaseUrl).toBe(base.DATABASE_URL);
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

  it("re-roots the store paths when EMBED_BENCH_DIR is set", () => {
    const config = loadEmbedBenchConfig({ ...base, EMBED_BENCH_DIR: "tmp/store" });
    expect(config.dir).toBe("tmp/store");
    expect(config.probePath).toBe("tmp/store/samples/probes.json");
    expect(config.sealPath).toBe("tmp/store/samples/version.json");
    expect(config.runsDir).toBe("tmp/store/runs");
    expect(config.reportPath).toBe("tmp/store/report.md");
  });

  it("honors sample and report path overrides", () => {
    const config = loadEmbedBenchConfig({
      ...base,
      BENCH_PROBE_PATH: "custom/probes.json",
      BENCH_EXPANSION_PATH: "custom/expansion.json",
      BENCH_REPORT_PATH: "custom/report.md",
    });
    expect(config.probePath).toBe("custom/probes.json");
    expect(config.expansionPath).toBe("custom/expansion.json");
    expect(config.reportPath).toBe("custom/report.md");
  });
});
