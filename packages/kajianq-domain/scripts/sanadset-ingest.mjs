#!/usr/bin/env bun
/**
 * sanadset-ingest.mjs — the `ingest:sanadset` Bun CLI for the S2 pilot: the Sahih
 * al-Bukhari slice's narrators and chains written through the store seam.
 *
 *   bun run ingest:sanadset -- --collection bukhari --dry-run
 *   bun run ingest:sanadset -- --collection bukhari --snapshot <label>
 *   bun run ingest:sanadset -- --collection bukhari --test-allow-no-snapshot   # disposable DB only
 *
 *   --collection <key>   the one collection this pilot ingests (bukhari)
 *   --dry-run            print the plan and counts; write nothing
 *   --run-id <slug>      report run id (default: s2-<collection>-<sha256 prefix>)
 *   --report <path>      JSON report path (default: per-user cache, run-scoped)
 *   --snapshot <label>   the verified pre-ingest snapshot the run requires
 *   --test-allow-no-snapshot  write without a snapshot; disposable databases only
 *   --csv <path>         Sanadset archive (default: per-user cache)
 *   --sha256 <hex>       accept a different archive than the pinned digest
 *   --children-limit <n> stored children compared for reconciliation (default 50000)
 *   --help               this text
 *
 * The guard runs before the archive is read: without `--dry-run`, a verified
 * snapshot label (the `db:snapshot verify` semantics) or the explicit test escape,
 * the command refuses and exits 1. `db:snapshot verify` is spawned rather than
 * reimplemented, so "verified" means exactly what the operator's command means, and
 * a missing DATABASE_URL is a refusal because the verification must compare the
 * live corpus counts.
 *
 * This script is the composition root: the environment, the home directory and the
 * snapshot verifier are read here and injected into the package. It reads no
 * vendor configuration and makes no model call.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as app from "@app/infra";
import * as pilot from "@app/kajianq-domain/sanadset-ingest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DB_SNAPSHOT = fileURLToPath(
  new URL("../../../packages/infra/scripts/db-snapshot.mjs", import.meta.url),
);

const USAGE = `ingest:sanadset — the S2 Sanadset pilot (Sahih al-Bukhari slice)

  --collection <key>        bukhari (the pilot's only collection)
  --dry-run                 print the plan and counts; write nothing
  --run-id <slug>           report run id (default: from the archive digest)
  --report <path>           JSON report path (outside the checkout)
  --snapshot <label>        verified pre-ingest snapshot label (required to write)
  --test-allow-no-snapshot  explicit escape: write without a snapshot
  --csv <path>              Sanadset archive (default: per-user cache)
  --sha256 <hex>            accept a different archive than the pinned digest
  --children-limit <n>      stored children compared (default ${pilot.DEFAULT_CHILD_READ_LIMIT})
  --help                    this text
`;

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}

function fail(message) {
  log("error", "ingest failed", { message });
  process.stderr.write(`ingest:sanadset: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { booleans: new Set(), values: new Map(), errors: [] };
  const takesValue = new Set([
    "--collection",
    "--run-id",
    "--report",
    "--snapshot",
    "--csv",
    "--sha256",
    "--children-limit",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--test-allow-no-snapshot" || arg === "--help") {
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

function integerFlag(values, name) {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * The production verifier: run the operator's own command and take its exit code.
 * `db:snapshot verify` re-downloads the dump, hashes it against the manifest, and
 * compares the manifest's corpus counts to the live database; 0 means verified, 2
 * means corpus drift, anything else is a failed verification. With no DATABASE_URL
 * the command would skip the live comparison and still exit 0, so the guard refuses
 * before spawning — an integrity-only check is not a verified snapshot of this store.
 */
function verifySnapshot(label) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    return {
      verified: false,
      label,
      reasons: [
        "DATABASE_URL is not set, so `db:snapshot verify` cannot compare live corpus counts",
      ],
    };
  }
  const result = spawnSync(process.execPath, [DB_SNAPSHOT, "verify", label], {
    cwd: REPO,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0) {
    return {
      verified: true,
      label,
      reasons: [`db:snapshot verify ${label}: exit 0`],
    };
  }
  const detail = `${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("db-snapshot:"));
  return {
    verified: false,
    label,
    reasons:
      detail.length > 0
        ? detail
        : [`db:snapshot verify ${label} exited ${result.status ?? "without a status"}`],
  };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.booleans.has("help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.errors.length > 0) fail(`${parsed.errors.join("; ")}\n\n${USAGE}`);

// Flags before environment: a bad flag must report itself even when the environment
// is also incomplete (the study CLI's rule, and the reason a typo never looks like a
// missing database).
const DRY_RUN = parsed.booleans.has("dry-run");
const TEST_ESCAPE = parsed.booleans.has("test-allow-no-snapshot");
let config;
try {
  const collection = parsed.values.get("collection") ?? "bukhari";
  const scope = pilot.resolvePilotCollection(collection);
  const runId = parsed.values.get("run-id");
  if (runId !== undefined && !pilot.RUN_ID_RE.test(runId)) {
    throw new Error(`--run-id must match ${pilot.RUN_ID_RE.source}, got "${runId}"`);
  }
  const report = parsed.values.get("report");
  if (report !== undefined) pilot.assertPilotReportPath(report);
  config = {
    scope,
    report,
    ...(runId === undefined ? {} : { runId }),
    snapshot: parsed.values.get("snapshot"),
    csvPath:
      parsed.values.get("csv") ?? pilot.defaultCsvPath({ env: process.env, homeDir: homedir() }),
    sha256: parsed.values.get("sha256") ?? pilot.S1_SOURCE_SHA256,
    childrenLimit: integerFlag(parsed.values, "children-limit"),
  };
} catch (error) {
  fail(pilot.describeIngestError(error));
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  fail("DATABASE_URL is not set — the pilot reads the corpus it reconciles against");
}

// The gate is resolved before the archive is read or a store client is built: a
// refused run must not have opened anything.
let gate;
try {
  gate = await pilot.resolveIngestGate({
    dryRun: DRY_RUN,
    testAllowNoSnapshot: TEST_ESCAPE,
    ...(config.snapshot === undefined ? {} : { label: config.snapshot }),
    verify: verifySnapshot,
  });
} catch (error) {
  fail(pilot.describeIngestError(error));
}
if (!gate.allowed) {
  fail(`refusing to write: no verified pre-ingest snapshot\n${gate.reasons.join("\n")}`);
}
for (const reason of gate.reasons) log(DRY_RUN ? "info" : "warn", "snapshot gate", { reason });
log("info", "gate resolved", { mode: gate.mode, label: gate.label, dryRun: DRY_RUN });

const logger = app.createLogger({ script: "ingest:sanadset" });
const store = app.resolvePostgresStore(databaseUrl, { logger });
const command = `bun ${process.argv.slice(1).join(" ")}`;
log("info", "ingest starting", {
  collection: config.scope.collection,
  book: config.scope.book,
  csv: config.csvPath,
  dryRun: DRY_RUN,
  expectedSha256: config.sha256,
});

let run;
try {
  run = await pilot.runSanadsetIngest({
    csvPath: config.csvPath,
    expectedSha256: config.sha256,
    scope: config.scope,
    store,
    gate,
    dryRun: DRY_RUN,
    command,
    homeDir: homedir(),
    ...(config.runId === undefined ? {} : { runId: config.runId }),
    ...(config.report === undefined ? {} : { reportPath: config.report }),
    ...(config.childrenLimit === undefined ? {} : { childReadLimit: config.childrenLimit }),
  });
} catch (error) {
  fail(pilot.describeIngestError(error));
}

const facts = run.document.pilot;
log("info", "ingest complete", {
  runId: run.runId,
  dryRun: run.dryRun,
  gate: facts.gate,
  written: run.written,
  sliceRows: facts.slice.rows,
  preparedRows: facts.slice.prepared,
  quarantined: facts.quarantine.total,
  narratorFoldedNames: facts.narrator.foldedNames,
  narratorVariants: facts.narrator.variantsRecorded,
  narratorResolutionRate: Number(facts.narrator.resolutionRate.toFixed(4)),
  uncertainNarratorPairs: facts.narrator.uncertainPairs,
  matnGroups: facts.matn.groups,
  matchedGroups: facts.matn.matchedGroups,
  ambiguousGroups: facts.matn.ambiguousGroups,
  newChildren: facts.matn.newChildren,
  childrenCreated: facts.write.children.created,
  childrenUpdated: facts.write.children.updated,
  childrenUnchanged: facts.write.children.unchanged,
  childrenDeleted: facts.write.children.deleted,
  matchRate: Number(facts.matn.matchRate.value.toFixed(4)),
  chainsPlanned: facts.chains.planned,
  chainsCreated: facts.write.chains.created,
  chainsUpdated: facts.write.chains.updated,
  chainsUnchanged: facts.write.chains.unchanged,
  chainsDeleted: facts.write.chains.deleted,
  nameClustersUpserted: facts.narrator.upserted,
  modelCalls: facts.cost.modelCalls,
  costMicroUsd: facts.cost.costMicroUsd,
});
