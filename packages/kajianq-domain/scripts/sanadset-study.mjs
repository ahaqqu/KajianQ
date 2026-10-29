#!/usr/bin/env bun
/**
 * sanadset-study.mjs — the `study:sanadset` Bun CLI for the S1 reconciliation study.
 *
 *   bun run study:sanadset -- [flags]
 *
 *   --no-model              deterministic pass only (never builds a model client)
 *   --provider <id>         dashscope (default) or ollama
 *   --model <id>            model id; defaults to the provider's pilot model
 *   --max-calls <n>         request ceiling for this run; never above the hard ceiling
 *   --csv <path>            archive path (default: the per-user cache)
 *   --out <dir>             artifact directory (default: the per-user cache)
 *   --limit <n>             read only the first n data records (a bounded rehearsal)
 *   --seed <n>              override the sample seed (default: derived from the file hash)
 *   --sha256 <hex>          accept a different archive than the pinned digest
 *   --price-in/--price-out  USD per million tokens, for a model with no price on file
 *
 * The credential comes from `DASHSCOPE_API_KEY` / `OLLAMA_API_KEY`, or from the
 * machine-local key file the provider profile names. A missing credential is not an
 * error: the run proceeds without the model arm and reports the band it would have
 * adjudicated. The key is never printed.
 *
 * Output is structured JSON lines on stdout. The shared logger adapter lives inside the
 * store package, and importing it here would pull a database client into a tool whose
 * defining property is that it constructs none.
 */
import * as study from "@app/kajianq-domain/sanadset";

const USAGE = `study:sanadset — Sanadset S1 reconciliation study (no store writes)

  --no-model              deterministic pass only
  --provider <id>         dashscope | ollama       (default: dashscope)
  --model <id>            model id                 (default: provider pilot model)
  --max-calls <n>         request ceiling          (max ${study.S1_MODEL_CALL_CEILING})
  --csv <path>            Sanadset archive         (default: per-user cache)
  --out <dir>             artifact directory       (default: per-user cache)
  --limit <n>             read only the first n records (bounded rehearsal)
  --seed <n>              sample seed override     (default: from the file hash)
  --sha256 <hex>          accept a different archive than the pinned digest
  --price-in <usd/mtok>   input price override
  --price-out <usd/mtok>  output price override
  --help                  this text
`;

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}

function fail(message) {
  log("error", "study failed", { message });
  process.stderr.write(`study:sanadset: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { booleans: new Set(), values: new Map(), errors: [] };
  const takesValue = new Set([
    "--provider",
    "--model",
    "--max-calls",
    "--csv",
    "--out",
    "--limit",
    "--seed",
    "--price-in",
    "--price-out",
    "--sha256",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-model" || arg === "--help") {
      parsed.booleans.add(arg.slice(2));
      continue;
    }
    if (!takesValue.has(arg)) {
      parsed.errors.push(`unknown argument ${arg}`);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed.errors.push(`${arg} needs a value`);
      continue;
    }
    parsed.values.set(arg.slice(2), value);
    index += 1;
  }
  return parsed;
}

function integerFlag(values, name, { min = 0 } = {}) {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`--${name} must be an integer >= ${min}, got "${raw}"`);
  return value;
}

function numberFlag(values, name) {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name} must be a non-negative number, got "${raw}"`);
  return value;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.booleans.has("help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.errors.length > 0) {
  fail(`${parsed.errors.join("; ")}\n\n${USAGE}`);
}

let config;
try {
  const provider = parsed.values.get("provider") ?? "dashscope";
  if (provider !== "dashscope" && provider !== "ollama")
    throw new Error(`--provider must be dashscope or ollama, got "${provider}"`);
  const armRequest = { provider };
  const model = parsed.values.get("model");
  if (model !== undefined) armRequest.model = model;
  const priceIn = numberFlag(parsed.values, "price-in");
  const priceOut = numberFlag(parsed.values, "price-out");
  if (priceIn !== undefined) armRequest.priceInUsdPerMTok = priceIn;
  if (priceOut !== undefined) armRequest.priceOutUsdPerMTok = priceOut;
  const limit = integerFlag(parsed.values, "limit", { min: 1 });
  const seed = integerFlag(parsed.values, "seed", { min: 0 });
  config = {
    noModel: parsed.booleans.has("no-model"),
    arm: study.resolveArm(armRequest),
    ceiling: study.resolveCallCeiling(integerFlag(parsed.values, "max-calls", { min: 1 })),
    csvPath: parsed.values.get("csv") ?? study.defaultCsvPath(),
    sha256: parsed.values.get("sha256") ?? study.S1_SOURCE_SHA256,
    outDir: parsed.values.get("out") ?? study.resolveOutDir(),
    ...(limit === undefined ? {} : { limit }),
    ...(seed === undefined ? {} : { seed }),
  };
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const lookup = study.loadApiKey(config.arm);
const status = study.describeArm(config.arm, lookup);
log("info", "arm resolved", {
  provider: status.provider,
  model: status.model,
  endpoint: status.baseUrl,
  keyPresent: status.keyPresent,
  keySource: status.keySource,
  keyDetail: status.keyDetail,
  ceiling: config.ceiling,
  noModel: config.noModel,
});
if (!config.noModel && !status.keyPresent) {
  log("warn", "model arm will not run: no credential", {
    detail: status.keyDetail,
    costOfArmIfKeyed: "see the pre-flight projection in the report",
  });
}

const command = `bun ${process.argv.slice(1).join(" ")}`;
log("info", "study starting", {
  csv: config.csvPath,
  out: config.outDir,
  limit: config.limit ?? null,
  expectedSha256: config.sha256,
});

let run;
try {
  run = await study.runSanadsetStudy({
    csvPath: config.csvPath,
    outDir: config.outDir,
    command,
    expectedSha256: config.sha256,
    ceiling: config.ceiling,
    capMicroUsd: study.STUDY_CAP_MICRO_USD,
    arm: { requested: !config.noModel, definition: config.arm, lookup },
    ...(config.limit === undefined ? {} : { limit: config.limit }),
    ...(config.seed === undefined ? {} : { seed: config.seed }),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const facts = run.document.study;
log("info", "study complete", {
  runId: run.runId,
  written: run.written,
  sliceRows: facts.slice.rows,
  preparedRows: facts.slice.prepared,
  quarantined: facts.quarantine.total,
  resolutionRate: Number(facts.narrator.resolutionRate.toFixed(4)),
  matchRateInSlice: Number(facts.matn.matchRate.value.toFixed(4)),
  distinctMatns: facts.matn.distinctMatns,
  chainsPerChild: Number(facts.matn.chainsPerChild.toFixed(4)),
  matnBandRows: facts.band.matnRows,
  narratorBandPairs: facts.band.narratorPairs,
  callsNeeded: facts.band.callsNeeded,
  callsBudgeted: facts.band.callsBudgeted,
  sampleSelected: facts.sample.selected,
  armStopReason: facts.modelArm.stopReason,
  armCalls: facts.modelArm.calls,
  armRequests: facts.modelArm.requests,
  spendMicroUsd: facts.modelArm.spendMicroUsd,
  estimatedSpendMicroUsd: facts.modelArm.estimate?.costMicroUsd ?? null,
});
for (const gate of facts.gates)
  log("info", "gate", { id: gate.id, status: gate.status, measured: gate.measured });
