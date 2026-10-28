import { useEffect, useState } from "react";
import { fetchAdminTraces, type AdminTraceQuery } from "../../lib/admin-client";
import { formatMessage, t, type Locale } from "../../lib/i18n";

/**
 * The search column: the filters, one page of results, and the pager.
 *
 * Every filter is a URL parameter on the request (the server owns the matching), and
 * the list holds no rows of its own beyond the page it fetched — the operator is
 * looking at the database's answer, not the browser's filtered copy of an older one.
 * A failed read says so; it never renders an empty table, because "no matches" and
 * "the read failed" are different findings for someone hunting a failure.
 */
type Page = Awaited<ReturnType<typeof fetchAdminTraces>>;

const FILTER_FIELDS = [
  { name: "q", label: "adminSearchLabel", placeholder: "adminSearchPlaceholder" },
  { name: "intent", label: "adminIntentLabel" },
  { name: "model", label: "adminModelLabel" },
  { name: "minLatencyMs", label: "adminMinLatencyLabel" },
  { name: "minCostMicroUsd", label: "adminMinCostLabel" },
  { name: "from", label: "adminFromLabel" },
  { name: "to", label: "adminToLabel" },
] as const;

type FilterName = (typeof FILTER_FIELDS)[number]["name"];

export function AdminTraceSearch({
  locale,
  selectedId,
  onSelect,
}: {
  locale: Locale;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Record<FilterName, string>>({
    q: "",
    intent: "",
    model: "",
    minLatencyMs: "",
    minCostMicroUsd: "",
    from: "",
    to: "",
  });
  const [flags, setFlags] = useState({ refused: false, filterRelaxed: false });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState<AdminTraceQuery>({});
  const [result, setResult] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetchAdminTraces({ ...query, page: String(page) }, controller.signal)
      .then(setResult)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [query, page]);

  const apply = () => {
    setPage(1);
    setQuery({
      ...draft,
      ...(flags.refused ? { refused: "true" } : {}),
      ...(flags.filterRelaxed ? { filterRelaxed: "true" } : {}),
    });
  };

  return (
    <div className="space-y-4">
      <form
        data-testid="admin-filters"
        className="grid grid-cols-2 gap-3 rounded-xl border border-rule bg-card p-4 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        {FILTER_FIELDS.map((field) => (
          <label key={field.name} className="space-y-1 text-xs">
            <span className="block font-mono uppercase tracking-wide text-muted-foreground">
              {t(locale, field.label)}
            </span>
            <input
              name={field.name}
              data-testid={`admin-filter-${field.name}`}
              className="w-full rounded-lg border border-rule bg-background px-2 py-1.5 text-sm"
              placeholder={"placeholder" in field ? t(locale, field.placeholder) : undefined}
              value={draft[field.name]}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            name="refused"
            data-testid="admin-filter-refused"
            checked={flags.refused}
            onChange={(event) => setFlags((c) => ({ ...c, refused: event.target.checked }))}
          />
          {t(locale, "adminRefusedLabel")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            name="filterRelaxed"
            data-testid="admin-filter-relaxed"
            checked={flags.filterRelaxed}
            onChange={(event) => setFlags((c) => ({ ...c, filterRelaxed: event.target.checked }))}
          />
          {t(locale, "adminRelaxedLabel")}
        </label>
        <button
          type="submit"
          data-testid="admin-apply"
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground"
        >
          {t(locale, "adminApply")}
        </button>
      </form>

      {failed && (
        <p role="alert" data-testid="admin-list-error" className="text-sm text-muted-foreground">
          {t(locale, "adminError")}
        </p>
      )}

      {result !== null && (
        <>
          <p
            data-testid="admin-results-count"
            className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            {formatMessage(locale, "adminResults", {
              count: result.items.length,
              total: result.total,
            })}
          </p>
          {result.items.length === 0 ? (
            <p data-testid="admin-empty" className="text-sm text-muted-foreground">
              {t(locale, "adminEmpty")}
            </p>
          ) : (
            <ul
              data-testid="admin-traces"
              className="divide-y divide-rule rounded-xl border border-rule bg-card"
            >
              {result.items.map((item) => (
                <li key={item.messageId}>
                  <button
                    type="button"
                    data-testid={`admin-trace-${item.messageId}`}
                    aria-current={item.traceId === selectedId ? "true" : undefined}
                    className={`w-full px-4 py-3 text-left hover:bg-background ${
                      item.traceId === selectedId ? "bg-background" : ""
                    }`}
                    onClick={() => onSelect(item.traceId)}
                  >
                    <span className="block truncate text-sm text-card-foreground">
                      {item.question}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {item.answer}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              data-testid="admin-prev"
              className="rounded-lg border border-rule px-3 py-1.5 disabled:opacity-50"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t(locale, "adminPrev")}
            </button>
            <span data-testid="admin-page" className="font-mono text-xs text-muted-foreground">
              {formatMessage(locale, "adminPageLabel", { page })}
            </span>
            <button
              type="button"
              data-testid="admin-next"
              className="rounded-lg border border-rule px-3 py-1.5 disabled:opacity-50"
              disabled={page * result.pageSize >= result.total}
              onClick={() => setPage((current) => current + 1)}
            >
              {t(locale, "adminNext")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
