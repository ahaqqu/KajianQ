import type { ReactNode } from "react";
import type { ChatTraceChain, ChatTraceChunk, ChatTraceReviewer } from "@app/contracts";
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
 * One source on record: its ordinal, its display title (or id), its fused score
 * when the trace recorded one, and the anchor for an "irrelevant passage"
 * report. The number is the consultation order the frame preserved.
 */
export function SourceRow({
  chunk,
  index,
  locale,
  score,
  messageId,
  persisted,
  feedback = true,
}: {
  chunk: ChatTraceChunk;
  index: number;
  locale: Locale;
  score: Intl.NumberFormat;
  messageId: string;
  persisted: boolean;
  feedback?: boolean;
}) {
  return (
    <li
      data-testid="trace-source"
      className="flex flex-col items-start gap-1 border-t border-rule py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    >
      <span className="min-w-0 max-w-full truncate text-sm text-card-foreground sm:flex-1">
        <span className="mr-2 font-mono text-[11px] text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        {chunk.source ?? <span className="font-mono text-xs">{chunk.id}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {chunk.score !== undefined && (
          <span data-testid="trace-score" className="font-mono text-[11px] text-muted-foreground">
            {t(locale, "traceScoreLabel")} {score.format(chunk.score)}
          </span>
        )}
        {feedback && (
          <FlagButton
            messageId={messageId}
            persisted={persisted}
            anchor={{ type: "chunk", category: "irrelevant_chunk", id: chunk.id }}
            labelKey="flagIrrelevantChunk"
            testId={`trace-flag-${chunk.id}`}
          />
        )}
      </span>
    </li>
  );
}

/** One technical-layer passage: display title (or id) plus its scores. */
export function ChunkRow({
  chunk,
  locale,
  score,
}: {
  chunk: ChatTraceChunk;
  locale: Locale;
  score: Intl.NumberFormat;
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
    </li>
  );
}

/**
 * The chains consulted: one row per child the run read transmission rows for,
 * each naming the passage and every row it holds with that row's grade, grader and
 * Arabic sanad. Rendered from the server-derived frame, in the record's order — the
 * panel reports what was consulted, never a selected best chain. Chain-bearing
 * passages the read did not cover are listed separately as unread: the panel must
 * not let them look like passages that hold no row.
 */
export function ChainsSection({
  chains,
  notConsulted,
  locale,
}: {
  chains: readonly ChatTraceChain[];
  notConsulted: readonly string[];
  locale: Locale;
}) {
  return (
    <div data-testid="trace-chains">
      <MonoLabel>{t(locale, "traceChainsLabel")}</MonoLabel>
      {chains.length === 0 && notConsulted.length === 0 ? (
        <p data-testid="trace-no-chains" className="mt-1 text-sm text-muted-foreground">
          {t(locale, "traceNoChains")}
        </p>
      ) : (
        <>
          {chains.length > 0 && (
            <ul className="mt-1 space-y-1">
              {chains.map((child) => (
                <li key={child.childId} data-testid="trace-chain-child" className="text-sm">
                  <span className="font-mono text-xs text-muted-foreground">
                    {t(locale, "traceChainChildLabel")}: {child.childId}
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {child.chains.map((chain, index) => (
                      <li
                        key={`${chain.grade ?? "ungraded"}-${index}`}
                        data-testid="trace-chain-row"
                      >
                        <span className="mr-2 font-mono text-[11px] uppercase tracking-wide text-card-foreground">
                          {chain.grade ?? t(locale, "traceChainUngraded")}
                        </span>
                        {chain.grader !== undefined && (
                          <span className="mr-2 text-xs text-muted-foreground">
                            {t(locale, "traceChainGraderLabel")}: {chain.grader}
                          </span>
                        )}
                        <span dir="rtl" lang="ar" className="font-arabic text-base">
                          {chain.narrators
                            .map((narrator) => narrator.nameAr ?? narrator.id)
                            .join(" < ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {notConsulted.length > 0 && (
            <div data-testid="trace-chains-unread" className="mt-1">
              <p className="text-sm text-muted-foreground">{t(locale, "citationChainUnread")}</p>
              <ul className="mt-0.5 space-y-0.5">
                {notConsulted.map((childId) => (
                  <li
                    key={childId}
                    data-testid="trace-chain-unread"
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {childId}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
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
