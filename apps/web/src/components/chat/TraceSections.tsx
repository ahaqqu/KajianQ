import type { ReactNode } from "react";
import type { ChatTraceChunk, ChatTraceReviewer } from "@app/contracts";
import { t, type Locale, type MessageKey } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import { FlagButton } from "./FeedbackControls";

/**
 * The Trace panel's rows and blocks, kept beside `TraceBody` so the panel's
 * layout stays one readable file under the agentic line cap: one source on
 * record, one technical-layer passage, the timeline step that carries them, and
 * the reviewer pre-gate's verdict.
 */

/**
 * One cited source: its ordinal, the citation label the answer wrote (the exact
 * reference a reader checks), and the passage's display title beside it. The
 * number is the citation order the frame preserved. No flag: the answer's
 * citations are the sheet's to flag as wrong; the irrelevant-passage report
 * belongs to the consulted passages in the technical layer.
 */
export function SourceRow({ chunk, index }: { chunk: ChatTraceChunk; index: number }) {
  return (
    <li
      data-testid="trace-source"
      className="flex flex-col items-start gap-1 border-t border-rule py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    >
      <span className="min-w-0 max-w-full truncate text-sm text-card-foreground sm:flex-1">
        <span className="mr-2 font-mono text-[11px] text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        {chunk.label ?? chunk.source ?? <span className="font-mono text-xs">{chunk.id}</span>}
        {chunk.label !== undefined && chunk.source !== undefined && (
          <span className="ml-2 text-xs text-muted-foreground">{chunk.source}</span>
        )}
      </span>
    </li>
  );
}

/**
 * One technical-layer passage: display title (or id), its scores, and the anchor
 * for an "irrelevant passage" report — the consulted set is what retrieval
 * tuning reads, so the report lives here, on the chunk the answer did not use.
 */
export function ChunkRow({
  chunk,
  locale,
  score,
  messageId,
  persisted,
  feedback = true,
}: {
  chunk: ChatTraceChunk;
  locale: Locale;
  score: Intl.NumberFormat;
  messageId: string;
  persisted: boolean;
  feedback?: boolean;
}) {
  return (
    <li className="text-sm text-card-foreground">
      {chunk.source ?? <span className="font-mono text-xs">{chunk.id}</span>}
      {chunk.score !== undefined && (
        <span
          data-testid="trace-score"
          className="ml-2 font-mono text-[11px] text-muted-foreground"
        >
          {t(locale, "traceScoreLabel")} {score.format(chunk.score)}
        </span>
      )}
      {chunk.rerankScore !== undefined && (
        <span
          data-testid="trace-rerank-score"
          className="ml-2 font-mono text-[11px] text-muted-foreground"
        >
          {t(locale, "traceRerankScoreLabel")} {score.format(chunk.rerankScore)}
        </span>
      )}
      {feedback && (
        <FlagButton
          messageId={messageId}
          persisted={persisted}
          anchor={{ type: "chunk", category: "irrelevant_chunk", id: chunk.id }}
          labelKey="flagIrrelevantChunk"
          testId={`trace-chunk-flag-${chunk.id}`}
        />
      )}
    </li>
  );
}

/** A timeline step: the accent dot sits on the section's left rule. */
export function Step({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="absolute top-1.5 -left-[22px] size-2 rounded-full bg-accent"
      />
      {children}
    </div>
  );
}

/**
 * The reviewer pre-gate's verdict (ADR-0042), rendered from the frame the server
 * derived: which way the screening call decided, why it escalated, the threshold
 * the outcome was computed against when the frame carries one, and how every
 * citation scored. An unscored citation reads as "not judged" — the pre-gate could
 * not judge it, and a zero would be a number it never produced.
 */
export function ReviewerSection({
  reviewer,
  locale,
  score,
}: {
  reviewer: ChatTraceReviewer;
  locale: Locale;
  score: Intl.NumberFormat;
}) {
  return (
    <div data-testid="trace-reviewer">
      <MonoLabel>{t(locale, "traceReviewerLabel")}</MonoLabel>
      <p data-testid="trace-reviewer-outcome" className="mt-1 text-sm text-card-foreground">
        {t(
          locale,
          reviewer.outcome === "skip" ? "traceReviewerOutcomeSkip" : "traceReviewerOutcomeEscalate",
        )}
      </p>
      {reviewer.reason !== undefined && (
        <p data-testid="trace-reviewer-reason" className="mt-1 text-sm text-card-foreground">
          {reasonLabel(locale, reviewer.reason)}
        </p>
      )}
      {reviewer.threshold !== undefined && (
        <p className="mt-1 text-sm text-card-foreground">
          <span className="mr-2 text-muted-foreground">
            {t(locale, "traceReviewerThresholdLabel")}
          </span>
          <span
            data-testid="trace-reviewer-threshold"
            className="font-mono text-[11px] text-muted-foreground"
          >
            {score.format(reviewer.threshold)}
          </span>
        </p>
      )}
      {reviewer.items.length > 0 && (
        <ul data-testid="trace-reviewer-items" className="mt-1 space-y-0.5">
          {reviewer.items.map((item) => (
            <li
              key={`${item.key}-${item.index}`}
              data-testid="trace-reviewer-item"
              className="text-sm text-card-foreground"
            >
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                {String(item.index + 1).padStart(2, "0")}
              </span>
              {item.key}
              {item.score !== undefined ? (
                <span
                  data-testid="trace-reviewer-score"
                  className="ml-2 font-mono text-[11px] text-muted-foreground"
                >
                  {t(locale, "traceReviewerScoreLabel")} {score.format(item.score)}
                </span>
              ) : (
                <span
                  data-testid="trace-reviewer-unscored"
                  className="ml-2 font-mono text-[11px] text-muted-foreground"
                >
                  {t(locale, "traceReviewerUnscored")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The event's escalation reason in the reader's language. The vocabulary is the
 * decision event's own; a value this copy has not learned yet renders verbatim
 * rather than disappearing. A Map, not an object literal: the reason is an opaque
 * string, and an object would resolve `__proto__`/`constructor` to inherited
 * members instead of reaching the verbatim fallback.
 */
const REVIEWER_REASON_KEYS = new Map<string, MessageKey>([
  ["below_threshold", "traceReviewerReasonBelowThreshold"],
  ["no_items", "traceReviewerReasonNoItems"],
  ["malformed_answer", "traceReviewerReasonMalformedAnswer"],
  ["vendor_failure", "traceReviewerReasonVendorFailure"],
]);

function reasonLabel(locale: Locale, reason: string): string {
  const key = REVIEWER_REASON_KEYS.get(reason);
  return key === undefined ? reason : t(locale, key);
}
