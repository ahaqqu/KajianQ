import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fetchHealth } from "../lib/health";
import { formatWhen, t, type Locale } from "../lib/i18n";
import { Card } from "./ui";

export function HomePage({ locale }: { locale: Locale }) {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: 1,
  });

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t(locale, "homeTitle")}
        </h1>
        <p className="text-slate-400">{t(locale, "homeSubtitle")}</p>
        <Link
          to="/notes"
          className="inline-block text-sky-400 underline"
          data-testid="nav-notes"
        >
          {t(locale, "notes")}
        </Link>
      </header>
      <Card>
        <h2 className="mb-2 text-sm text-slate-300">{t(locale, "health")}</h2>
        {health.isPending && (
          <p className="text-slate-400">{t(locale, "loading")}</p>
        )}
        {health.isError && (
          <p className="text-amber-300">{t(locale, "offline")}</p>
        )}
        {health.data && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">{t(locale, "env")}</dt>
            <dd>{health.data.env}</dd>
            <dt className="text-slate-500">{t(locale, "schema")}</dt>
            <dd data-testid="schema-version">{health.data.schemaVersion}</dd>
            <dt className="text-slate-500">time</dt>
            <dd>{formatWhen(locale, new Date())}</dd>
          </dl>
        )}
      </Card>
    </div>
  );
}
