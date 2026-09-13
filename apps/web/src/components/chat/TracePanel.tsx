import { useState } from "react";
import type { ChatTraceChunk, ChatTraceFrame } from "@app/contracts";
import { t, useLocale, type Locale } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import { FlagButton } from "./FeedbackControls";

/**
 * The user-facing Trace panel (#12, ADR-0007): every answer expands to show
 * how it was built, in two layers. The default view lists the sources
 * consulted in plain language — readable by a non-technical user. One tap
 * deeper, the technical layer shows the router intent, sub-queries, the
 * retrieved passages with their scores, and the model identities — all
 * server-derived from the persisted answer trace and rendered as-is; the
 * client never reconstructs pipeline machinery. ADR-0007's warning stands:
 * this panel is the feedback instrument, not UI clutter — do not clean it up.
 * The instrument part is literal since #13: each source row carries a flag
 * affordance anchoring an "irrelevant chunk" report to that chunk's id — the
 * server re-validates the anchor against the persisted trace before storing.
 *
 * Rendered only when the message carries a trace frame; a message without
 * one (user turns, degraded traces) shows no affordance, by data.
 */

export function TracePanel({
  trace,
  messageId,
}: {
  trace: ChatTraceFrame | undefined;
  messageId: string;
}) {
  const locale: Locale = useLocale();
  const [open, setOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  if (trace === undefined) return null;
  const score = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const { technical } = trace;
  return (
    <div data-testid="trace-panel" className="ml-10 mt-2 max-w-[95%]">
      <button
        type="button"
        data-testid="trace-toggle"
        aria-expanded={open}
        aria-controls="trace-body"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        {t(locale, "traceToggle")}
      </button>
      {open && (
        <div
          id="trace-body"
          data-testid="trace-body"
          className="mt-2 space-y-3 rounded-xl border border-rule bg-card px-4 py-3"
        >
          <div>
            <MonoLabel>{t(locale, "traceSourcesLabel")}</MonoLabel>
            {trace.sources.length === 0 ? (
              <p data-testid="trace-no-sources" className="mt-1 text-sm text-muted-foreground">
                {t(locale, "traceNoSources")}
              </p>
            ) : (
              <ul data-testid="trace-sources" className="mt-1 space-y-0.5">
                {trace.sources.map((chunk) => (
                  <li
                    key={chunk.id}
                    data-testid="trace-source"
                    className="flex items-center justify-between gap-2 text-sm text-card-foreground"
                  >
                    <span>
                      {chunk.source ?? <span className="font-mono text-xs">{chunk.id}</span>}
                    </span>
                    <FlagButton
                      messageId={messageId}
                      anchor={{ type: "chunk", category: "irrelevant_chunk", id: chunk.id }}
                      labelKey="flagIrrelevantChunk"
                      testId={`trace-flag-${chunk.id}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            data-testid="trace-tech-toggle"
            aria-expanded={techOpen}
            aria-controls="trace-technical"
            className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-card-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setTechOpen((v) => !v)}
          >
            <Chevron open={techOpen} />
            {t(locale, "traceTechnicalToggle")}
          </button>
          {techOpen && (
            <div id="trace-technical" data-testid="trace-technical" className="space-y-2">
              {technical.intent !== undefined && (
                <p data-testid="trace-intent" className="text-sm text-card-foreground">
                  <MonoLabel className="mr-2 inline">{t(locale, "traceIntentLabel")}</MonoLabel>
                  {technical.intent}
                </p>
              )}
              {technical.subQueries.length > 0 && (
                <div data-testid="trace-subqueries">
                  <MonoLabel>{t(locale, "traceSubqueriesLabel")}</MonoLabel>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {technical.subQueries.map((text, index) => (
                      // Index-stabilized key (thermo-review B4): duplicate
                      // sub-query texts must not collide as React keys.
                      <li key={`${text}-${index}`} className="text-sm text-card-foreground">
                        {text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {technical.chunks.length > 0 && (
                <div data-testid="trace-chunks">
                  <MonoLabel>{t(locale, "traceChunksLabel")}</MonoLabel>
                  <ul className="mt-1 space-y-0.5">
                    {technical.chunks.map((chunk) => (
                      <ChunkRow key={chunk.id} chunk={chunk} locale={locale} score={score} />
                    ))}
                  </ul>
                </div>
              )}
              {technical.models.length > 0 && (
                <div data-testid="trace-models">
                  <MonoLabel>{t(locale, "traceModelsLabel")}</MonoLabel>
                  <ul className="mt-1 space-y-0.5">
                    {technical.models.map((model) => (
                      <li key={model} className="font-mono text-xs text-card-foreground">
                        {model}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One technical-layer passage: display title (or id) plus its fused score. */
function ChunkRow({
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
    </li>
  );
}

/** The disclosure caret; rotation communicates the expanded state to sight. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
