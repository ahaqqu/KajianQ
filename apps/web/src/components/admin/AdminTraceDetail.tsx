import { useEffect, useState } from "react";
import { adminRawTraceUrl, fetchAdminTrace } from "../../lib/admin-client";
import { t, type Locale } from "../../lib/i18n";
import { TraceBody } from "../chat/TraceBody";

/**
 * One answer, as the operator sees it: the question and answer text, the totals over
 * every provider call the answer made, the calls themselves, the stored trace as a
 * download, and the Trace panel the chat renders — the same component, fed the frame
 * the server derived from the persisted trace, never a second rendering of the events.
 *
 * The panel runs in its read-only mode: its flag buttons are a write into the
 * feedback ledger, and this surface writes nothing.
 */
type Detail = Awaited<ReturnType<typeof fetchAdminTrace>>;

export function AdminTraceDetail({ locale, traceId }: { locale: Locale; traceId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setDetail(null);
    fetchAdminTrace(traceId, controller.signal)
      .then(setDetail)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [traceId]);

  if (failed) {
    return (
      <p role="alert" data-testid="admin-detail-error" className="text-sm text-muted-foreground">
        {t(locale, "adminError")}
      </p>
    );
  }
  if (detail === null) {
    return (
      <p data-testid="admin-detail-loading" className="text-sm text-muted-foreground">
        {t(locale, "adminLoading")}
      </p>
    );
  }

  const { totals } = detail;
  return (
    <article data-testid="admin-detail" className="space-y-4">
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="font-mono uppercase tracking-wide text-muted-foreground">
            {t(locale, "adminTokensLabel")}
          </dt>
          <dd data-testid="admin-totals-tokens" className="text-sm">
            {totals.tokensIn} / {totals.tokensOut}
          </dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wide text-muted-foreground">
            {t(locale, "adminCostLabel")}
          </dt>
          <dd data-testid="admin-totals-cost" className="text-sm">
            {totals.costMicroUsd}
          </dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wide text-muted-foreground">
            {t(locale, "adminLatencyLabel")}
          </dt>
          <dd data-testid="admin-totals-latency" className="text-sm">
            {totals.latencyMs}
          </dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wide text-muted-foreground">
            {t(locale, "adminTraceIdLabel")}
          </dt>
          <dd className="break-all font-mono text-[11px]">{detail.traceId}</dd>
        </div>
      </dl>

      <div className="space-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(locale, "adminQuestionLabel")}
        </h3>
        <p data-testid="admin-detail-question" className="text-sm">
          {detail.question}
        </p>
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(locale, "adminAnswerLabel")}
        </h3>
        <p data-testid="admin-detail-answer" className="text-sm">
          {detail.answer}
        </p>
      </div>

      <section data-testid="admin-calls" className="space-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(locale, "adminCallsLabel")}
        </h3>
        <ul className="space-y-1 text-xs">
          {detail.calls.map((call, index) => (
            <li key={`${call.stage}-${call.modelId}-${index}`} className="font-mono">
              <span className="text-accent">{call.stage}</span>
              {" · "}
              {call.modelId}
              {" · "}
              {call.tokensIn + call.tokensOut} {t(locale, "adminCallTokensLabel")}
              {" · "}
              {call.latencyMs} ms
              {" · "}
              {call.costMicroUsd} µUSD
            </li>
          ))}
        </ul>
      </section>

      <a
        data-testid="admin-raw-link"
        href={adminRawTraceUrl(detail.traceId)}
        download={`trace-${detail.traceId}.json`}
        className="inline-block rounded-lg border border-rule px-3 py-1.5 text-sm underline underline-offset-4"
      >
        {t(locale, "adminRawDownload")}
      </a>

      <TraceBody
        trace={detail.frame}
        messageId={detail.messageId}
        persisted={true}
        feedback={false}
      />
    </article>
  );
}
