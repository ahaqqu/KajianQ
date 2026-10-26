import { useState } from "react";
import type { ChatTraceChunk, ChatTraceFrame } from "@app/contracts";
import { t, useLocale, type Locale } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import { FlagButton } from "./FeedbackControls";

/**
 * The user-facing Trace panel (ADR-0007): every answer expands to show how it
 * was built, in two layers. The default view lists the sources consulted in
 * plain language — readable by a non-technical user. One tap deeper, the
 * technical layer shows the router intent, sub-queries, the retrieved passages
 * with their scores, and the model identities — all server-derived from the
 * persisted answer trace and rendered as-is; the client never reconstructs
 * pipeline machinery. ADR-0007's warning stands: this panel is the feedback
 * instrument, not UI clutter — do not clean it up.
 *
 * Each source row carries a flag affordance anchoring an "irrelevant chunk"
 * report to that chunk's id — the server re-validates the anchor against the
 * persisted trace before storing. `persisted` gates the flag affordance: a live
 * turn before `meta` has no row for the report to name.
 */
export function TraceBody({
  trace,
  messageId,
  persisted,
}: {
  trace: ChatTraceFrame;
  messageId: string;
  persisted: boolean;
}) {
  const locale: Locale = useLocale();
  const [techOpen, setTechOpen] = useState(false);
  const score = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const { technical } = trace;

  return (
    <div
      id="trace-body"
      data-testid="trace-body"
      className="mt-1 space-y-4 rounded-xl border border-rule bg-card px-4 py-4"
    >
      <section>
        <MonoLabel>{t(locale, "traceSourcesLabel")}</MonoLabel>
        {trace.sources.length === 0 ? (
          <p data-testid="trace-no-sources" className="mt-2 text-sm text-muted-foreground">
            {t(locale, "traceNoSources")}
          </p>
        ) : (
          <ol data-testid="trace-sources" className="mt-2">
            {trace.sources.map((chunk, index) => (
              <SourceRow
                key={chunk.id}
                chunk={chunk}
                index={index}
                locale={locale}
                score={score}
                messageId={messageId}
                persisted={persisted}
              />
            ))}
          </ol>
        )}
      </section>

      <section>
        <button
          type="button"
          data-testid="trace-tech-toggle"
          aria-expanded={techOpen}
          aria-controls="trace-technical"
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-card-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setTechOpen((value) => !value)}
        >
          <span aria-hidden="true">{techOpen ? "−" : "+"}</span>
          {t(locale, "traceTechnicalToggle")}
        </button>

        {techOpen && (
          <div
            id="trace-technical"
            data-testid="trace-technical"
            className="mt-3 space-y-4 border-l border-rule pl-4"
          >
            {technical.intent !== undefined && (
              <Step>
                <p data-testid="trace-intent" className="text-sm text-card-foreground">
                  <MonoLabel className="mr-2 inline">{t(locale, "traceIntentLabel")}</MonoLabel>
                  {technical.intent}
                </p>
              </Step>
            )}
            {technical.routing !== undefined && (
              <Step>
                <div data-testid="trace-routing">
                  {/* The route's SELECTION, never a claim about what ran: the run
                      can give the source dimension up (the "given up" row below,
                      projected from the retriever's own events), and then every
                      source was searched. The label says "selected" so the row
                      never asserts a restriction the search has already dropped;
                      the deviation is the given-up row's job. */}
                  <MonoLabel>{t(locale, "traceRoutingLabel")}</MonoLabel>
                  <p
                    data-testid="trace-routing-sources"
                    className="mt-1 text-sm text-card-foreground"
                  >
                    {technical.routing.sources.length === 0
                      ? t(locale, "traceRoutingAllSources")
                      : technical.routing.sources.join(" · ")}
                  </p>
                  {Object.entries(technical.routing.filters).length > 0 && (
                    <p
                      data-testid="trace-routing-filters"
                      className="mt-1 text-sm text-card-foreground"
                    >
                      <span className="mr-2 text-muted-foreground">
                        {t(locale, "traceRoutingFiltersLabel")}
                      </span>
                      {Object.entries(technical.routing.filters)
                        .map(([key, values]) => `${key}: ${values.join(", ")}`)
                        .join(" · ")}
                    </p>
                  )}
                  {/* The filters the run GAVE UP — a hint that matched nothing is
                      probed away and retried, and the panel names which one, so a
                      relaxed filter is never displayed as one that ran. */}
                  {(technical.routing.relaxed?.length ?? 0) > 0 && (
                    <p
                      data-testid="trace-routing-relaxed"
                      className="mt-1 text-sm text-card-foreground"
                    >
                      <span className="mr-2 text-muted-foreground">
                        {t(locale, "traceRoutingRelaxedLabel")}
                      </span>
                      {technical.routing.relaxed
                        ?.map(({ key, values }) => `${key}: ${values.join(", ")}`)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              </Step>
            )}
            {technical.subQueries.length > 0 && (
              <Step>
                <div data-testid="trace-subqueries">
                  <MonoLabel>{t(locale, "traceSubqueriesLabel")}</MonoLabel>
                  <ul className="mt-1 space-y-0.5">
                    {/* Index-stabilized key: duplicate sub-query texts must not
                        collide as React keys. */}
                    {technical.subQueries.map((text, index) => (
                      <li key={`${text}-${index}`} className="text-sm text-card-foreground">
                        {text}
                      </li>
                    ))}
                  </ul>
                </div>
              </Step>
            )}
            {technical.chunks.length > 0 && (
              <Step>
                <div data-testid="trace-chunks">
                  <MonoLabel>{t(locale, "traceChunksLabel")}</MonoLabel>
                  <ul className="mt-1 space-y-0.5">
                    {technical.chunks.map((chunk) => (
                      <ChunkRow key={chunk.id} chunk={chunk} locale={locale} score={score} />
                    ))}
                  </ul>
                </div>
              </Step>
            )}
            {technical.models.length > 0 && (
              <Step>
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
              </Step>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One source on record: its ordinal, its display title (or id), its fused score
 * when the trace recorded one, and the anchor for an "irrelevant passage"
 * report. The number is the consultation order the frame preserved.
 */
function SourceRow({
  chunk,
  index,
  locale,
  score,
  messageId,
  persisted,
}: {
  chunk: ChatTraceChunk;
  index: number;
  locale: Locale;
  score: Intl.NumberFormat;
  messageId: string;
  persisted: boolean;
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
        <FlagButton
          messageId={messageId}
          persisted={persisted}
          anchor={{ type: "chunk", category: "irrelevant_chunk", id: chunk.id }}
          labelKey="flagIrrelevantChunk"
          testId={`trace-flag-${chunk.id}`}
        />
      </span>
    </li>
  );
}

/** One technical-layer passage: display title (or id) plus its scores. */
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

/** A timeline step: the accent dot sits on the section's left rule. */
function Step({ children }: { children: React.ReactNode }) {
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
