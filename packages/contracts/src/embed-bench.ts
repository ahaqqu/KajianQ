import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * Embed-bench contracts (issue #9, ADR-0013/0014/0036): the committed run-file
 * shape for the embedding-benchmark store — one append-only record per
 * candidate arm, in the same discipline as the decision-bench run file. A run
 * pins what it measured (the samples seal version, the probe/expansion hashes,
 * the corpus fingerprint) so the report derives every number from the records
 * and refuses a run measured against different bytes than the committed
 * samples. Probe texts, corpus ids and fingerprints arrive as opaque strings —
 * the contract never names a source, a language pair, or a vendor.
 */

/** The k of recall@k the gate scores — also the width of a record's ranked top-k. */
export const EMBED_BENCH_TOP_K = 10;

/** The bench's direction vocabulary — the gate rows plus the expansion micro-task. */
export const EMBED_BENCH_DIRECTIONS = [
  "secondary→primary",
  "primary→primary",
  "secondary→secondary",
  "expansion",
] as const;

export const EmbedBenchDirectionSchema = v.picklist(EMBED_BENCH_DIRECTIONS);

export type EmbedBenchDirection = v.InferOutput<typeof EmbedBenchDirectionSchema>;

/**
 * The two directions the gate floors judge (ADR-0013), mapped to their floor's
 * key in a run's `gate.floors`; the other directions are reported, never gated.
 */
export const EMBED_BENCH_GATE_FLOOR_KEY = {
  "secondary→primary": "crossLingual",
  "primary→primary": "monolingual",
} as const;

/**
 * One scored probe inside a committed run file. Retrieval records carry the
 * ground-truth ids and the ranked top-k ids actually retrieved (rank = position
 * in `got`); expansion records carry the expected term and the picked terms.
 * `cost` is the metered spend of the one call that produced the record — only
 * the expansion micro-task is one-call-per-case, so only its records carry one.
 */
export const EmbedBenchRunRecordSchema = v.object({
  probeId: v.pipe(v.string(), v.minLength(1)),
  direction: EmbedBenchDirectionSchema,
  expected: v.union([
    v.pipe(v.string(), v.minLength(1)),
    v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  ]),
  got: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(EMBED_BENCH_TOP_K)),
  passed: v.boolean(),
  cost: v.optional(CostRecordSchema),
});

export type EmbedBenchRunRecord = v.InferOutput<typeof EmbedBenchRunRecordSchema>;

/**
 * The committed run file: one append-only record per candidate arm. The gate
 * floors ride along so a run states what it was judged against; the report
 * recomputes the verdict from the records with the floors in force now and
 * flags a disagreement instead of trusting the pinned one.
 */
export const EmbedBenchRunSchema = v.object({
  schema: v.literal(1),
  task: v.literal("embed-bench"),
  /** The candidate model id, as resolved from the embedder-candidates chain. */
  model: v.pipe(v.string(), v.minLength(1)),
  samples: v.object({
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    probesSha256: v.pipe(v.string(), v.minLength(1)),
    expansionSha256: v.pipe(v.string(), v.minLength(1)),
    corpusFingerprint: v.pipe(v.string(), v.minLength(1)),
  }),
  budget: v.object({
    capMicroUsd: v.nullable(v.number()),
    plannedCalls: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    totalMicroUsd: v.pipe(v.number(), v.minValue(0)),
  }),
  totals: v.object({
    probes: v.record(
      v.pipe(v.string(), v.minLength(1)),
      v.pipe(v.number(), v.integer(), v.minValue(1)),
    ),
    recallAt10: v.record(v.pipe(v.string(), v.minLength(1)), v.nullable(v.number())),
    mrr: v.record(v.pipe(v.string(), v.minLength(1)), v.nullable(v.number())),
    expansionAccuracy: v.nullable(v.number()),
  }),
  gate: v.object({
    gatePass: v.boolean(),
    failedDirections: v.array(v.pipe(v.string(), v.minLength(1))),
    floors: v.object({
      crossLingual: v.number(),
      monolingual: v.number(),
    }),
  }),
  /** An aborted run keeps its partial records and names the failure. */
  aborted: v.optional(v.boolean()),
  error: v.optional(v.pipe(v.string(), v.minLength(1))),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
  finishedAt: v.pipe(v.string(), v.isoTimestamp()),
  records: v.array(EmbedBenchRunRecordSchema),
});

export type EmbedBenchRun = v.InferOutput<typeof EmbedBenchRunSchema>;

/**
 * Recall@k of one retrieval record: |expected ∩ got| / |expected| (0 for an
 * empty ground truth — never a vacuous 1). Null for an expansion record,
 * which carries no ranked list.
 */
export function embedRecordRecall(r: EmbedBenchRunRecord): number | null {
  if (typeof r.expected === "string") return null;
  const got = new Set(r.got);
  const hits = r.expected.filter((id) => got.has(id)).length;
  return hits / r.expected.length;
}

/**
 * Reciprocal rank of one retrieval record: 1 / (position of the first
 * expected id in `got`), 0 when none landed in the top k. Null for an
 * expansion record.
 */
export function embedRecordMrr(r: EmbedBenchRunRecord): number | null {
  if (typeof r.expected === "string") return null;
  const expected = new Set(r.expected);
  for (let i = 0; i < r.got.length; i += 1) {
    if (expected.has(r.got[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** The per-direction aggregates a run's totals must agree with. */
export type EmbedDirectionStats = {
  probes: number;
  recallAt10: number | null;
  mrr: number | null;
};

/**
 * Aggregate a run's records per direction. A direction's mean is over the
 * records that yield a metric; an expansion direction (no ranked lists)
 * reports null recall/MRR rather than a fabricated 0.
 */
export function embedDirectionStats(
  records: readonly EmbedBenchRunRecord[],
): Record<string, EmbedDirectionStats> {
  const sums = new Map<
    string,
    { probes: number; recall: number; recallN: number; mrr: number; mrrN: number }
  >();
  for (const r of records) {
    const s = sums.get(r.direction) ?? { probes: 0, recall: 0, recallN: 0, mrr: 0, mrrN: 0 };
    s.probes += 1;
    const recall = embedRecordRecall(r);
    const mrr = embedRecordMrr(r);
    if (recall !== null) {
      s.recall += recall;
      s.recallN += 1;
    }
    if (mrr !== null) {
      s.mrr += mrr;
      s.mrrN += 1;
    }
    sums.set(r.direction, s);
  }
  const out: Record<string, EmbedDirectionStats> = {};
  for (const [direction, s] of sums) {
    out[direction] = {
      probes: s.probes,
      recallAt10: s.recallN === 0 ? null : s.recall / s.recallN,
      mrr: s.mrrN === 0 ? null : s.mrr / s.mrrN,
    };
  }
  return out;
}

/** Mean pass rate over the expansion records; null when none ran. */
export function embedExpansionAccuracy(records: readonly EmbedBenchRunRecord[]): number | null {
  const expansion = records.filter((r) => r.direction === "expansion");
  if (expansion.length === 0) return null;
  return expansion.filter((r) => r.passed).length / expansion.length;
}

/**
 * Parse an untrusted run-file payload with the consistency checks the schema
 * cannot express: the totals must be derivable from the records (a summary
 * that disagrees with its own evidence is a corrupted run), a retrieval
 * record's `passed` must agree with its own top-k recall, the gate verdict
 * must follow from the floors and the per-direction means, and an aborted run
 * must name its failure while a complete one carries none.
 */
export function parseEmbedBenchRun(raw: unknown): EmbedBenchRun {
  const run = v.parse(EmbedBenchRunSchema, raw);
  const prefix = `embed-bench run "${run.model}"`;

  for (const r of run.records) {
    if (r.direction === "expansion") {
      if (typeof r.expected !== "string") {
        throw new Error(
          `${prefix}: expansion record "${r.probeId}" must carry the expected term as a string`,
        );
      }
      continue;
    }
    if (typeof r.expected === "string") {
      throw new Error(
        `${prefix}: retrieval record "${r.probeId}" (${r.direction}) must carry the relevant ids as an array`,
      );
    }
    if (r.passed !== (embedRecordRecall(r) === 1)) {
      throw new Error(
        `${prefix}: retrieval record "${r.probeId}" (${r.direction}) passed ${r.passed} disagrees with its top-k recall`,
      );
    }
  }

  const stats = embedDirectionStats(run.records);
  const recordDirections = Object.keys(stats).sort().join(",");
  for (const key of ["probes", "recallAt10", "mrr"] as const) {
    if (Object.keys(run.totals[key]).sort().join(",") !== recordDirections) {
      throw new Error(
        `${prefix}: totals.${key} must describe exactly the run's record directions (${recordDirections || "none"})`,
      );
    }
  }

  for (const [direction, s] of Object.entries(stats)) {
    if (run.totals.probes[direction] !== s.probes) {
      throw new Error(
        `${prefix}: totals.probes["${direction}"] ${run.totals.probes[direction]} does not match its ${s.probes} records`,
      );
    }
    for (const key of ["recallAt10", "mrr"] as const) {
      const claimed = run.totals[key][direction];
      const mean = s[key];
      const agrees =
        claimed !== undefined &&
        ((claimed === null && mean === null) ||
          (claimed !== null && mean !== null && Math.abs(claimed - mean) <= 1e-9));
      if (!agrees) {
        throw new Error(
          `${prefix}: totals.${key}["${direction}"] ${String(claimed)} does not match the records' ${String(mean)}`,
        );
      }
    }
  }

  const accuracy = embedExpansionAccuracy(run.records);
  const claimedAccuracy = run.totals.expansionAccuracy;
  const accuracyAgrees =
    (accuracy === null && claimedAccuracy === null) ||
    (accuracy !== null && claimedAccuracy !== null && Math.abs(claimedAccuracy - accuracy) <= 1e-9);
  if (!accuracyAgrees) {
    throw new Error(
      `${prefix}: totals.expansionAccuracy ${String(claimedAccuracy)} does not match the expansion records' ${String(accuracy)}`,
    );
  }

  const failed = Object.entries(EMBED_BENCH_GATE_FLOOR_KEY)
    .filter(([direction, floorKey]) => {
      return (run.totals.recallAt10[direction] ?? 0) < run.gate.floors[floorKey];
    })
    .map(([direction]) => direction);
  if (failed.sort().join(",") !== run.gate.failedDirections.slice().sort().join(",")) {
    throw new Error(
      `${prefix}: gate.failedDirections [${run.gate.failedDirections.join(", ")}] does not match the floors' verdict [${failed.join(", ")}]`,
    );
  }
  if (run.gate.gatePass !== (failed.length === 0)) {
    throw new Error(
      `${prefix}: gate.gatePass ${run.gate.gatePass} disagrees with ${failed.length} failed direction(s)`,
    );
  }

  if (run.aborted === true && (run.error === undefined || run.error.length === 0)) {
    throw new Error(`${prefix}: aborted without an error message`);
  }
  if (run.aborted !== true && run.error !== undefined) {
    throw new Error(`${prefix}: carries an error but is not aborted`);
  }
  return run;
}
