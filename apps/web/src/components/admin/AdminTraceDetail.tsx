import { useEffect, useState } from "react";
import { adminRawTraceUrl, fetchAdminTrace } from "../../lib/admin-client";
import { formatNumber, t, type Locale, type MessageKey } from "../../lib/i18n";
import { TraceBody } from "../chat/TraceBody";

/**
 * One answer, as the operator sees it: the question and answer text, the totals over
 * every provider call the answer made, the calls themselves with each call's model
 * identity and cost consistency from the provider config, the stored trace as a
 * download, and the Trace panel the chat renders — the same component, fed the frame
 * the server derived from the persisted trace, never a second rendering of the events.
 *
 * The panel runs in its read-only mode: its flag buttons are a write into the
 * feedback ledger, and this surface writes nothing.
 */
type Detail = Awaited<ReturnType<typeof fetchAdminTrace>>;
type Consistency = Detail["calls"][number]["modelConfig"]["status"];

/** The sentence per consistency status, total over the closed vocabulary: a fourth
 * status reddens the typecheck instead of inheriting the "not in config" copy. */
const CONSISTENCY_MESSAGES: { [S in Consistency]: MessageKey } = {
  consistent: "adminCostConsistent",
  mismatch: "adminCostMismatch",
  unresolved: "adminCostUnresolved",
};

/** Whether the configured price accounts for the recorded figure. The recorded
 * `costMicroUsd` stays the figure shown beside the call; this only explains it. */
function consistencyLabel(locale: Locale, status: Consistency): string {
  return t(locale, CONSISTENCY_MESSAGES[status]);
}

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
        <ul className="space-y-2 text-xs">
          {detail.calls.map((call, index) => (
            <li key={`${call.stage}-${call.modelId}-${index}`} className="font-mono">
              <div>
                <span className="text-accent">{call.stage}</span>
                {" · "}
                {call.modelId}
                {" · "}
                {call.tokensIn + call.tokensOut} {t(locale, "adminCallTokensLabel")}
                {" · "}
                {call.latencyMs} ms
                {" · "}
                {call.costMicroUsd} µUSD
              </div>
              <div
                data-testid={`admin-call-model-${index}`}
                className="pl-2 text-[11px] text-muted-foreground"
              >
                {call.modelConfig.matches.length > 0 && (
                  <ul>
                    {call.modelConfig.matches.map((match) => (
                      <li
                        key={match.provider}
                        data-testid={`admin-call-match-${index}-${match.provider}`}
                      >
                        {t(locale, "adminCallProviderLabel")}: {match.provider}
                        {" · "}
                        {match.roles.join(", ")}
                        {" · "}
                        {t(locale, "adminCallPriceLabel")}:{" "}
                        {formatNumber(locale, match.priceMicroUsdPerMTok.in)} /{" "}
                        {formatNumber(locale, match.priceMicroUsdPerMTok.out)}
                        {" · "}
                        {t(locale, "adminCallConfigCostLabel")}:{" "}
                        {formatNumber(locale, match.computedCostMicroUsd)} µUSD
                      </li>
                    ))}
                  </ul>
                )}
                <span
                  data-testid={`admin-call-consistency-${index}`}
                  data-status={call.modelConfig.status}
                >
                  {consistencyLabel(locale, call.modelConfig.status)}
                </span>
              </div>
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
