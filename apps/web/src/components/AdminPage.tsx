import { useEffect, useState } from "react";
import { fetchAdminSession, logOut, type AdminSessionResponse } from "../lib/admin-client";
import { t, useLocale } from "../lib/i18n";
import { useAdminTraceParam } from "../lib/admin-deep-link";
import { AdminLogin, AdminTraceDetail, AdminTraceSearch } from "./admin/admin-parts";

/**
 * The admin Trace browser: sign in, search answers, open one.
 *
 * Its own chrome, deliberately not the public shell — the public header carries the
 * product's navigation and must not advertise this surface, so the two layouts stay
 * disjoint. Nothing here is reachable without the session cookie: the server answers
 * every read with the same 401, and this page renders the sign-in form on that
 * outcome rather than guessing why.
 */
export function AdminPage() {
  const locale = useLocale();
  const [session, setSession] = useState<AdminSessionResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [traceId, selectTrace] = useAdminTraceParam();

  useEffect(() => {
    const controller = new AbortController();
    fetchAdminSession(controller.signal)
      .then(setSession)
      .catch(() => {
        if (!controller.signal.aborted) setUnreachable(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              KajianQ
            </p>
            <h1 className="font-serif text-2xl font-semibold">{t(locale, "adminTitle")}</h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{t(locale, "adminReadOnlyNote")}</span>
            {session?.authenticated === true && (
              <button
                type="button"
                data-testid="admin-sign-out"
                className="rounded-lg border border-rule px-3 py-1.5"
                onClick={() => {
                  logOut(session.csrfToken)
                    .then(() => {
                      selectTrace(undefined);
                      return fetchAdminSession();
                    })
                    .then(setSession)
                    .catch(() => setSession({ authenticated: false, csrfToken: "" }));
                }}
              >
                {t(locale, "adminSignOut")}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8">
        <p className="max-w-3xl text-sm text-muted-foreground">{t(locale, "adminLead")}</p>

        {unreachable && (
          <p role="alert" data-testid="admin-unreachable" className="text-sm text-muted-foreground">
            {t(locale, "adminError")}
          </p>
        )}

        {session === null && !unreachable && (
          <p data-testid="admin-probing" className="text-sm text-muted-foreground">
            {t(locale, "adminLoading")}
          </p>
        )}

        {session !== null && !session.authenticated && (
          <AdminLogin locale={locale} csrfToken={session.csrfToken} onSignedIn={setSession} />
        )}

        {session?.authenticated === true && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AdminTraceSearch locale={locale} selectedId={traceId} onSelect={selectTrace} />
            <section aria-live="polite">
              {traceId === undefined ? (
                <p data-testid="admin-select-prompt" className="text-sm text-muted-foreground">
                  {t(locale, "adminSelectPrompt")}
                </p>
              ) : (
                <>
                  <AdminTraceDetail locale={locale} traceId={traceId} />
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t(locale, "adminDeepLinkNote")}
                  </p>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
