/**
 * The S1 study run: verify the bytes, stream the slice, pre-register the blind sample,
 * then (only if a key is present) let the model arm predict, and finally cascade and
 * report.
 *
 * Two invariants shape the order of operations. The sample is written to disk before the
 * first model request, so a later reader can prove the pairs were not chosen after
 * seeing an answer; and the study never constructs a database client, an object store or
 * a snapshot — it reads one file and writes one artifact directory.
 */

import {
  assembleReportDocument,
  buildMatnPairCandidates,
  buildNarratorPairCandidates,
  buildNarratorCatalogue,
  buildPreregistrationArtifact,
  createArmClient,
  createCallBudget,
  describeArm,
  hashFile,
  labelsTemplateRows,
  ownerSpotCheckRows,
  renderReportMarkdown,
  runMatnCascade,
  sampleSeed,
  selectBlindSample,
  toCsv,
  type ApiKeyLookup,
  type ArmDefinition,
  type FetchLike,
  type NarratorMention,
  type PairCandidates,
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
import {
  jsonFile,
  LABELS_CSV,
  PREDICTIONS_JSON,
  QUARANTINE_JSON,
  REPORT_JSON,
  REPORT_MARKDOWN,
  SAMPLE_JSON,
  SPOT_CHECK_CSV,
  writeArtifactFiles,
} from "./sanadset-artifacts";

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
  readonly document: StudyReportDocument;
  readonly quarantineRows: readonly QuarantinedRow[];
  readonly predictions: readonly SamplePrediction[];
  readonly written: readonly string[];
};

function collectMentions(
  rows: readonly { chain: readonly string[]; rawChain: readonly string[] }[],
): NarratorMention[] {
  const mentions: NarratorMention[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.chain.length; index += 1) {
      mentions.push({ raw: row.rawChain[index] ?? "", folded: row.chain[index] as string });
    }
  }
  return mentions;
}

function mergeCandidates(matn: PairCandidates, narrator: PairCandidates): PairCandidates {
  const merged: PairCandidates = new Map(matn);
  for (const [stratum, pairs] of narrator)
    merged.set(stratum, [...(merged.get(stratum) ?? []), ...pairs]);
  return merged;
}

/** Run the study end to end. Artifacts land in `outDir`; nothing else is written. */
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
  const chainBearing = slice.stats.rows - slice.stats.noSanad;

  const catalogue = buildNarratorCatalogue(collectMentions(prepared));
  const candidates = mergeCandidates(
    buildMatnPairCandidates(prepared),
    buildNarratorPairCandidates(catalogue),
  );
  const seed = options.seed ?? sampleSeed(hashed.sha256);
  const selection = selectBlindSample({ candidates, seed });
  const preregistration = buildPreregistrationArtifact({
    selection,
    sourceSha256: hashed.sha256,
    generatedAt: new Date(startedAt).toISOString(),
  });
  const written: string[] = writeArtifactFiles(options.outDir, [
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

  const budget = createCallBudget(options.ceiling);
  const cascade = await runMatnCascade({
    rows: prepared,
    budget,
    ...(client === null ? {} : { adjudicate: client.adjudicateMatn }),
  });
  const finishedAt = now();

  const estimate = estimateStudyCalls({
    pairs: selection.pairs,
    decisions: cascade.decisions,
    rawMatnByIndex: new Map(prepared.map((row) => [row.rowIndex, row.rawMatn])),
    ceiling: options.ceiling,
    price: options.arm.definition.price,
  });

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
    "Narrator identity pairs are counted but not adjudicated: narrator resolution against the corpus is S2 work.",
    "Trigram Jaccard is a lexical score over character trigrams; two texts that share a long borrowed phrase can score high without being the same narration.",
    ...(options.limit === undefined
      ? []
      : [
          `--limit ${options.limit} bounded the read (${slice.recordsRead} records); these counts are not a full-file census.`,
        ]),
  ];

  const runId = `s1-${hashed.sha256.slice(0, 12)}-${seed.toString(16)}${options.limit === undefined ? "" : `-limit${options.limit}`}`;
  const facts = buildStudyFacts({
    runId,
    command: options.command,
    source: {
      fileName: options.csvPath.split("/").pop() ?? options.csvPath,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
      recordsRead: slice.recordsRead,
    },
    stats: slice.stats,
    prepared,
    chainBearing,
    cascade,
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
    callsNeeded: estimate.calls,
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
    ...writeArtifactFiles(options.outDir, [
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
      ...writeArtifactFiles(options.outDir, [
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
  return { runId, document, quarantineRows, predictions, written };
}
