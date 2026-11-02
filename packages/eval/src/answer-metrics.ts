import type { EvalResultOutcome } from "@app/contracts";
import type { CitationFrameLike, CitationGrammar, TraceEventLike } from "./harness-types";
import { citationEvidenceLabels } from "./scorers";

/**
 * Descriptive per-answer size and citation counts, and their per-run aggregates.
 *
 * Every figure is derived from the same three inputs the scorer already holds for one
 * answer — its text, its trace events and its citations frame — so no second answer
 * source can enter the report. No gate reads any figure here: they describe the run,
 * they do not decide it.
 */

/**
 * The citation labels one answer carries, under the gate's own evidence precedence:
 * the citations frame first (an EMPTY frame is authoritative), then the trace's
 * review-event grounded list, then the injected grammar's spans in the answer text.
 *
 * Deduplicated under the grammar's normalization, so a repeated citation counts once
 * and one range label counts once even though it names several addresses. With
 * neither non-text evidence nor a grammar the text cannot be split into citations, so
 * the count is 0 rather than an invented span.
 */
export function answerCitationLabels(input: {
  answerText: string;
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
  grammar?: CitationGrammar | undefined;
}): string[] {
  const evidence = citationEvidenceLabels({ frame: input.frame, events: input.events });
  const labels =
    evidence ?? (input.grammar === undefined ? [] : input.grammar.labelsInText(input.answerText));
  const normalize = input.grammar?.normalizeLabel;
  return [...new Set(labels.map((label) => (normalize === undefined ? label : normalize(label))))];
}

/**
 * One answer's descriptive statistics. Length is in Unicode code points, so an astral
 * character counts once. Zero is a MEASURED value — an empty answer carrying no
 * citation — never a missing measurement.
 */
export function answerStats(input: {
  answerText: string;
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
  grammar?: CitationGrammar | undefined;
}): { answerChars: number; citationCount: number } {
  return {
    answerChars: Array.from(input.answerText).length,
    citationCount: answerCitationLabels(input).length,
  };
}

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((sum, x) => sum + x, 0) / xs.length;

const maxOrNull = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((largest, x) => (x > largest ? x : largest));

/**
 * The per-run mean and maximum answer length and citations per answer, over the
 * scored outcomes that carry the measurements. A row persisted before the metric
 * existed is excluded from every figure rather than counted as zero, because "never
 * measured" and "measured zero" are different facts. All four are null when no answer
 * was measured.
 *
 * One derivation, shared by the persisted report and the CLI summary, so the printed
 * figures and the stored ones cannot drift apart.
 */
export function answerMetricsSummary(scored: readonly EvalResultOutcome[]): {
  meanAnswerChars: number | null;
  maxAnswerChars: number | null;
  meanCitationsPerAnswer: number | null;
  maxCitationsPerAnswer: number | null;
} {
  const measured = scored.filter(
    (row) => row.answerChars !== undefined && row.citationCount !== undefined,
  );
  const chars = measured.map((row) => row.answerChars!);
  const citations = measured.map((row) => row.citationCount!);
  return {
    meanAnswerChars: mean(chars),
    maxAnswerChars: maxOrNull(chars),
    meanCitationsPerAnswer: mean(citations),
    maxCitationsPerAnswer: maxOrNull(citations),
  };
}
