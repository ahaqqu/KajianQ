/**
 * The pilot run: read, plan, (write), report — in that order, with the gate checked
 * before the first read and again in the write path.
 *
 * The run is a pure orchestration of the modules beside it; the only choices it
 * makes are the defaults (run id from the verified digest, child read bound) and the
 * order, which is the invariant: a refused gate stops before the archive is hashed,
 * a dry run stops before any write, and the report is built from the same plan the
 * write consumed.
 */

import type { RagStore } from "@app/infra";
import * as parts from "./sanadset-ingest-parts";

/** Children compared per reconciliation run; a larger corpus raises the flag. */
export const DEFAULT_CHILD_READ_LIMIT = 50_000;

/** A run id is also a directory name, so it is a plain slug — never a path. */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export type IngestRunOptions = {
  readonly csvPath: string;
  readonly expectedSha256: string;
  readonly scope: parts.PilotScope;
  readonly store: RagStore;
  readonly gate: parts.IngestGateDecision;
  readonly dryRun: boolean;
  readonly command: string;
  /** Where the JSON report lands; its Markdown digest lands beside it. */
  readonly reportPath?: string;
  /** The home directory the default report path is resolved from. */
  readonly homeDir: string;
  /** Defaults to `s2-<collection>-<sha256 prefix>`: one run id per archive. */
  readonly runId?: string;
  readonly childReadLimit?: number;
  readonly now?: () => number;
};

export type IngestRun = {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly plan: parts.IngestPlan;
  readonly outcome: parts.WriteOutcome | null;
  readonly document: parts.PilotReportDocument;
  readonly written: readonly string[];
};

export async function runSanadsetIngest(options: IngestRunOptions): Promise<IngestRun> {
  const now = options.now ?? (() => Date.now());
  // Before the archive is read: a refused gate is not a run that got part-way.
  if (!options.dryRun) parts.assertIngestGate(options.gate);
  if (options.dryRun && options.gate.mode !== "dry-run") {
    throw new Error("a dry run must carry the dry-run gate: no write path is allowed to run");
  }
  const startedAt = now();
  const slice = await parts.readSanadsetSlice({
    csvPath: options.csvPath,
    expectedSha256: options.expectedSha256,
  });
  const runId = options.runId ?? `s2-${options.scope.key}-${slice.source.sha256.slice(0, 12)}`;
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(
      `run id "${runId}" must match ${RUN_ID_RE.source}; it names the report directory`,
    );
  }

  const children = await parts.readCollectionChildren({
    store: options.store,
    collection: options.scope.collection,
    limit: options.childReadLimit ?? DEFAULT_CHILD_READ_LIMIT,
  });
  const plan = await parts.buildSanadsetPlan({
    scope: options.scope,
    rows: slice.prepared,
    sourceQuarantined: slice.quarantined,
    stats: slice.stats,
    children: children.children,
    childrenCapHit: children.capHit,
  });

  const outcome = options.dryRun
    ? null
    : await parts.executeIngestPlan({ store: options.store, plan, gate: options.gate });
  const finishedAt = now();
  const document = parts.buildPilotReport({
    runId,
    command: options.command,
    dryRun: options.dryRun,
    plan,
    source: { ...slice.source, recordsRead: slice.recordsRead },
    gate: {
      mode: options.gate.mode,
      label: options.gate.label,
      reasons: options.gate.reasons,
    },
    outcome,
    startedAt,
    finishedAt,
  });
  const reportPath = options.reportPath ?? parts.defaultPilotReportPath(options.homeDir, runId);
  const written = parts.writePilotReport(document, reportPath);
  return { runId, dryRun: options.dryRun, plan, outcome, document, written };
}
