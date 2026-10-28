import { useEffect, useState } from "react";
import { fetchAdminSession, logOut } from "../lib/admin-client";
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
 *
 * The session is a union, not a nullable boolean: every signed-out state carries a live
 * CSRF token the next sign-in must echo, so an empty token is not representable. Only a
 * 204 from the sign-out moves the page to signed-out. Any other outcome keeps the
 * authenticated view with the token it already had and says the sign-out failed: the
 * cookie is still live, so a probe that fails closed (a store fault) would otherwise
 * report a sign-out the server refused, and the operator would be shown a login form
 * while their session still works.
 */
type AdminSessionState =
  | { kind: "probing" }
  | { kind: "unreachable" }
  | { kind: "signed-out"; csrfToken: string }
  | { kind: "signed-in"; csrfToken: string; signOutFailed: boolean };

function stateOf(session: { authenticated: boolean; csrfToken: string }): AdminSessionState {
  return session.authenticated
    ? { kind: "signed-in", csrfToken: session.csrfToken, signOutFailed: false }
    : { kind: "signed-out", csrfToken: session.csrfToken };
}

export function AdminPage() {
  const locale = useLocale();
  const [session, setSession] = useState<AdminSessionState>({ kind: "probing" });
  const [traceId, selectTrace] = useAdminTraceParam();

  useEffect(() => {
    const controller = new AbortController();
    fetchAdminSession(controller.signal)
      .then((next) => setSession(stateOf(next)))
      .catch(() => {
        if (!controller.signal.aborted) setSession({ kind: "unreachable" });
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
            {session.kind === "signed-in" && (
              <button
                type="button"
                data-testid="admin-sign-out"
                className="rounded-lg border border-rule px-3 py-1.5"
                onClick={() => {
                  const csrfToken = session.csrfToken;
                  // A 204 is the only answer that ended the session server-side; every
                  // other outcome (a 503 it fails closed with, a refused CSRF pair, a
                  // network fault) leaves the cookie live, so the page keeps the
                  // authenticated view and says the sign-out failed. Re-probing here would
                  // be the trap: a probe whose store is unreachable answers
                  // `authenticated:false`, which is how the login form used to appear over
                  // a session that still worked.
                  logOut(csrfToken).then(
                    () => {
                      selectTrace(undefined);
                      fetchAdminSession()
                        .then((next) => setSession(stateOf(next)))
                        .catch(() => setSession({ kind: "unreachable" }));
                    },
                    () => setSession({ kind: "signed-in", csrfToken, signOutFailed: true }),
                  );
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

        {session.kind === "signed-in" && session.signOutFailed && (
          <p
            role="alert"
            data-testid="admin-sign-out-failed"
            className="max-w-3xl rounded-lg border border-rule px-3 py-2 text-sm"
          >
            {t(locale, "adminSignOutFailed")}
          </p>
        )}

        {session.kind === "unreachable" && (
          <p role="alert" data-testid="admin-unreachable" className="text-sm text-muted-foreground">
            {t(locale, "adminError")}
          </p>
        )}

        {session.kind === "probing" && (
          <p data-testid="admin-probing" className="text-sm text-muted-foreground">
            {t(locale, "adminLoading")}
          </p>
        )}

        {session.kind === "signed-out" && (
          <AdminLogin
            locale={locale}
            csrfToken={session.csrfToken}
            onSignedIn={(next) => setSession(stateOf(next))}
          />
        )}

        {session.kind === "signed-in" && (
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
