/**
 * The S1 study run: verify the bytes, stream the slice, pre-register the blind sample,
 * then (only if a key is present) let the model arm predict, and finally cascade and
 * report.
 *
 * Three invariants shape the order of operations. The sample is written to disk before
 * the first model request, so a later reader can prove the pairs were not chosen after
 * seeing an answer; every artifact lands in a run-scoped directory that a scored label
 * sheet makes unwritable, so a rerun cannot destroy the owner's evidence; and the study
 * never constructs a database client, an object store or a snapshot — it reads one file
 * and writes one artifact directory outside the checkout.
 */

import {
  assembleReportDocument,
  assertArtifactDirWritable,
  buildMatnPairCandidates,
  buildNarratorPairCandidates,
  buildNarratorCatalogue,
  buildPreregistrationArtifact,
  collectNarratorMentions,
  createArmClient,
  createCallBudget,
  describeArm,
  hashFile,
  jsonFile,
  LABELS_CSV,
  labelsTemplateRows,
  measureCrossBookJoins,
  mergePairCandidates,
  ownerSpotCheckRows,
  PREDICTIONS_JSON,
  QUARANTINE_JSON,
  REPORT_JSON,
  REPORT_MARKDOWN,
  renderReportMarkdown,
  runMatnCascade,
  SAMPLE_JSON,
  sampleSeed,
  selectBlindSample,
  SPOT_CHECK_CSV,
  toCsv,
  writeArtifactFiles,
  type ApiKeyLookup,
  type ArmDefinition,
  type FetchLike,
  type QuarantinedRow,
  type StudyReportDocument,
} from "./sanadset-core";
import {
  estimateStudyCalls,
  runSamplePredictions,
  summariseArm,
  type SamplePrediction,
} from "./sanadset-arm-run";
import { buildStudyFacts } from "./sanadset-facts";
import { streamSlice } from "./sanadset-stream";
import { join } from "node:path";

/** Hard per-run spend cap the study is measured against (AGENTS.md cost discipline). */
export const STUDY_CAP_MICRO_USD = 50_000_000;

/** The only archive bytes this study accepts; a different file is a different study. */
export const S1_SOURCE_SHA256 = "bbe4fd3d9ef797a78c9ddfdc7d31a9d2185c2f7efa0ecee75c9fc46b6dcfb5b3";

export type StudyArmOptions = {
  /** True when the run was asked to use a model; false for `--no-model`. */
  readonly requested: boolean;
  readonly definition: ArmDefinition;
  readonly lookup: ApiKeyLookup;
};

export type StudyOptions = {
  readonly csvPath: string;
  readonly outDir: string;
  readonly command: string;
  readonly expectedSha256: string;
  readonly ceiling: number;
  readonly capMicroUsd: number;
  readonly arm: StudyArmOptions;
  readonly limit?: number;
  readonly seed?: number;
  readonly now?: () => number;
  /** Injected transport for the arm; absent means the platform fetch. */
  readonly fetch?: FetchLike;
};

export type { SamplePrediction } from "./sanadset-arm-run";

export type StudyRun = {
  readonly runId: string;
  /** The run-scoped directory every artifact was written to. */
  readonly artifactsDir: string;
  readonly document: StudyReportDocument;
  readonly quarantineRows: readonly QuarantinedRow[];
  readonly predictions: readonly SamplePrediction[];
  readonly written: readonly string[];
};

/** The run id names the configuration: the archive bytes, the seed and any bound read. */
export function studyRunId(input: {
  readonly sha256: string;
  readonly seed: number;
  readonly limit?: number;
}): string {
  const suffix = input.limit === undefined ? "" : `-limit${input.limit}`;
  return `s1-${input.sha256.slice(0, 12)}-${input.seed.toString(16)}${suffix}`;
}

/** Run the study end to end. Artifacts land in `outDir/<runId>/`; nothing else is written. */
export async function runSanadsetStudy(options: StudyOptions): Promise<StudyRun> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const hashed = await hashFile(options.csvPath);
  if (hashed.sha256 !== options.expectedSha256) {
    throw new Error(
      `sanadset study: source sha256 ${hashed.sha256} does not match the pinned ${options.expectedSha256}`,
    );
  }
  const slice = await streamSlice(
    options.csvPath,
    options.limit === undefined ? {} : { limit: options.limit },
  );
  const prepared = slice.prepared;
  const isnadBearing = slice.stats.rows - slice.stats.noSanad;

  const seed = options.seed ?? sampleSeed(hashed.sha256);
  const runId = studyRunId({
    sha256: hashed.sha256,
    seed,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const artifactsDir = join(options.outDir, runId);
  // Before anything is written: a run whose target already carries scored labels stops
  // here, so the owner's evidence is never replaced by a rerun.
  assertArtifactDirWritable(artifactsDir);

  const catalogue = buildNarratorCatalogue(collectNarratorMentions(prepared));
  const candidates = mergePairCandidates(
    buildMatnPairCandidates(prepared),
    buildNarratorPairCandidates(catalogue),
  );
  const selection = selectBlindSample({ candidates, seed });
  const preregistration = buildPreregistrationArtifact({
    selection,
    sourceSha256: hashed.sha256,
    generatedAt: new Date(startedAt).toISOString(),
  });
  const written: string[] = writeArtifactFiles(artifactsDir, [
    { name: SAMPLE_JSON, content: jsonFile(preregistration) },
    { name: LABELS_CSV, content: toCsv(labelsTemplateRows(selection.pairs)) },
    { name: SPOT_CHECK_CSV, content: toCsv(ownerSpotCheckRows(selection.pairs, seed)) },
  ]);

  const status = describeArm(options.arm.definition, options.arm.lookup);
  const key = options.arm.lookup.key;
  const client =
    options.arm.requested && key !== null
      ? createArmClient({
          arm: options.arm.definition,
          apiKey: key.value,
          ceiling: options.ceiling,
          now,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
      : null;

  const predictions = client === null ? [] : await runSamplePredictions(client, selection.pairs);

  // One ceiling owns both halves: the cascade's budget starts from the requests the
  // sample has already issued, so `arm.requests` is the number the ceiling bounds.
  const spent = client?.totals().requests ?? 0;
  const budget = createCallBudget(Math.max(0, options.ceiling - spent));
  const cascade = await runMatnCascade({
    rows: prepared,
    budget,
    ...(client === null ? {} : { adjudicate: client.adjudicateMatn }),
  });
  // What an unscoped book would have joined across books: a measurement, not a constant.
  const crossBook = await measureCrossBookJoins(prepared, cascade);
  const finishedAt = now();

  const estimate = estimateStudyCalls({
    pairs: selection.pairs,
    decisions: cascade.decisions,
    rawMatnByIndex: new Map(prepared.map((row) => [row.rowIndex, row.rawMatn])),
    ceiling: options.ceiling,
    price: options.arm.definition.price,
  });
  // The plan the report reconciles: one call per pre-registered pair plus one per band row.
  const callsNeeded = selection.pairs.length + cascade.counts.bandAdjudicated;

  const { arm, costRecords } = summariseArm({
    status,
    requested: options.arm.requested,
    client,
    ceilingReached: cascade.model.ceilingReached,
    estimate,
    samplePredictions: predictions.length,
  });

  const quarantineRows: QuarantinedRow[] = [...slice.quarantined, ...cascade.quarantined];
  const limits = [
    "The v1 corpus match rate is not measured: S1 constructs no database client, so the reconciliation target is unread; the in-slice match rate measures coalescing only.",
    client === null
      ? "The model arm did not run, so no arm predicted the pre-registered sample and no macro-F1 or false-merge precision exists."
      : "The arm predicted the pre-registered sample blind; labels are owner-supplied, so no macro-F1 or false-merge precision exists yet.",
    "Narrator identity pairs are counted but not adjudicated: narrator resolution against the corpus is S2 work, and the coverage rate is a coalescing share, not identity evidence.",
    "Trigram Jaccard is a lexical score over character trigrams; two texts that share a long borrowed phrase can score high without being the same narration.",
    "Cross-book joins are counted by replaying the cascade against an unscoped book and count deterministic joins only; a model 'same' verdict on a keyed run could merge more.",
    ...(options.limit === undefined
      ? []
      : [
          `--limit ${options.limit} bounded the read (${slice.recordsRead} records); these counts are not a full-file census.`,
        ]),
  ];

  const facts = buildStudyFacts({
    runId,
    command: options.command,
    artifactsDir,
    source: {
      fileName: options.csvPath.split("/").pop() ?? options.csvPath,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
      recordsRead: slice.recordsRead,
    },
    stats: slice.stats,
    prepared,
    isnadBearing,
    cascade,
    crossBook,
    catalogue,
    sample: {
      seed,
      requested: selection.requested,
      selected: selection.selected,
      shortfall: selection.shortfall,
      composition: selection.composition,
      labelsPresent: false,
    },
    quarantined: quarantineRows,
    arm,
    ceiling: options.ceiling,
    callsNeeded,
    capMicroUsd: options.capMicroUsd,
    limits,
    timings: { startedAt, finishedAt, wallClockMs: finishedAt - startedAt },
  });
  const document = assembleReportDocument({
    facts,
    costRecords,
    quarantined: quarantineRows.length,
  });
  written.push(
    ...writeArtifactFiles(artifactsDir, [
      { name: REPORT_JSON, content: jsonFile(document) },
      { name: REPORT_MARKDOWN, content: renderReportMarkdown(document) },
      {
        name: QUARANTINE_JSON,
        content: jsonFile({
          generatedAt: new Date(finishedAt).toISOString(),
          sourceSha256: hashed.sha256,
          total: quarantineRows.length,
          byRule: facts.quarantine.byRule,
          rows: quarantineRows,
        }),
      },
    ]),
  );
  if (predictions.length > 0) {
    written.push(
      ...writeArtifactFiles(artifactsDir, [
        {
          name: PREDICTIONS_JSON,
          content: jsonFile({
            runId,
            generatedAt: new Date(finishedAt).toISOString(),
            model: arm.model,
            predictions,
          }),
        },
      ]),
    );
  }
  return { runId, artifactsDir, document, quarantineRows, predictions, written };
}
