import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/health";
import { formatWhen, t, type Locale } from "../lib/i18n";
import { AppHeader } from "./AppHeader";
import { Card, CardLabel } from "./ui";

/** The template's health route, restyled in the app's visual language. */
export function HomePage({ locale }: { locale: Locale }) {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: 1,
  });

  return (
    <div className="min-h-dvh">
      <header className="border-b border-dashed border-rule">
        <AppHeader />
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold italic">{t(locale, "homeTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t(locale, "homeSubtitle")}</p>
        </div>
        <Card>
          <CardLabel>{t(locale, "health")}</CardLabel>
          {health.isPending && <p className="mt-2 text-sm">{t(locale, "loading")}</p>}
          {health.isError && <p className="mt-2 text-sm text-destructive">{t(locale, "health")}: error</p>}
          {health.data && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t(locale, "env")}</dt>
              <dd>{health.data.env}</dd>
              <dt className="text-muted-foreground">{t(locale, "schema")}</dt>
              <dd data-testid="schema-version">{health.data.schemaVersion}</dd>
              <dt className="text-muted-foreground">{t(locale, "time")}</dt>
              <dd>{formatWhen(locale, new Date())}</dd>
            </dl>
          )}
        </Card>
      </main>
    </div>
  );
}
