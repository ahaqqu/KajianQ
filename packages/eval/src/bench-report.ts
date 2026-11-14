/**
 * The shared bench-report primitives: one implementation of every number and
 * section the four bench reports print (ADR-0042's store shape). Each report
 * keeps only what is its own — the title, the seal's samples bullets, the
 * bench-specific cells and the miss detail — and delegates the rest here, so
 * a formatting rule cannot drift between four copies, and the abort verdict
 * is decided once.
 */

/**
 * The Gate cell. An aborted arm is rendered as an abort, never as the
 * verdict its partial records happen to imply: the gate's own prose says an
 * arm that aborts is evidence, not a result.
 */
export function benchGateCell(opts: {
  pass: boolean;
  /** The verdict the run file pinned when it was written. */
  pinnedPass: boolean;
  aborted: boolean;
  error?: string | undefined;
}): string {
  if (opts.aborted) return `**abort** ⚠ aborted (${opts.error ?? "unnamed failure"})`;
  const disagree = opts.pass !== opts.pinnedPass ? " (pinned gate disagrees)" : "";
  return `**${opts.pass ? "pass" : "fail"}**${disagree}`;
}

/** p50 of the per-record latencies that exist (a record without one leaves the sample). */
export function p50LatencyMs(
  records: readonly { cost?: { latencyMs?: number } | undefined }[],
): number | null {
  const xs = records
    .map((r) => r.cost?.latencyMs)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor((xs.length - 1) / 2)]!;
}

export function fmtPct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

/**
 * A run's cost cell: the sum of its per-record spend, plus the run's own
 * budget field when the two disagree (a run whose summary does not follow
 * from its records is corrupted evidence, and the report says so).
 */
export function benchCostCell(
  records: readonly { cost?: { costMicroUsd?: number } | undefined }[],
  budgetTotalMicroUsd: number,
): string {
  const perCase = records.map((r) => r.cost?.costMicroUsd ?? 0).reduce((a, b) => a + b, 0);
  return `${perCase} µUSD total${budgetTotalMicroUsd !== perCase ? ` (budget bookkeeping ${budgetTotalMicroUsd})` : ""}`;
}

/** The arms table: its header, separator and rows, ready to push as lines. */
export function benchArmsTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
}

/**
 * The Misses section. `compact` collapses every miss into one bullet (the
 * summarizer's case-id list); otherwise each miss gets its own detail line.
 */
export function benchMissSection(
  arms: readonly { model: string; details: readonly string[] }[],
  opts: { compact?: boolean } = {},
): string[] {
  const lines = arms.flatMap(({ model, details }) => {
    if (details.length === 0) return [`- \`${model}\`: none.`];
    if (opts.compact === true) {
      return [`- \`${model}\` (${details.length}): ${details.map((d) => `\`${d}\``).join(", ")}`];
    }
    return [`- \`${model}\` (${details.length}):`, ...details.map((d) => `  - ${d}`)];
  });
  return ["## Misses", "", ...lines, ""];
}

/** The Selection section: the gate-passing arms, then what adoption still needs. */
export function benchSelectionSection(passing: readonly string[], note: string): string[] {
  return [
    "## Selection",
    "",
    passing.length === 0
      ? "No arm passes the gate at this seal."
      : `Gate-passing arms at this seal: ${passing.map((model) => `\`${model}\``).join(", ")}.`,
    "",
    note,
    "",
  ];
}

/** The Superseded section, omitted when the bench has no archived results. */
export function benchSupersededSection(count: number | undefined): string[] {
  if ((count ?? 0) <= 0) return [];
  return [
    "## Superseded",
    "",
    `${count} frozen result(s) under \`superseded/\` predate the committed seal or an earlier one — kept as history, never scored.`,
    "",
  ];
}

/** The report head every bench shares: title, gate paragraph, samples bullets. */
export function benchReportHead(opts: {
  title: string;
  /** The paragraph under the title: floors, provenance and what the gate measures. */
  intro: string;
  /** The samples bullets, each already formatted as a list item. */
  samples: readonly string[];
}): string[] {
  return [
    `# ${opts.title}`,
    "",
    opts.intro,
    "",
    "## Samples",
    "",
    ...opts.samples,
    "",
    "## Arms",
    "",
  ];
}
