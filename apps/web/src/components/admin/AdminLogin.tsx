import { useState } from "react";
import { logIn, type AdminSessionResponse } from "../../lib/admin-client";
import { t, type Locale } from "../../lib/i18n";

/**
 * The sign-in form. It renders only while the session probe says "signed out", and
 * it is the only place a password crosses the wire: the POST carries the CSRF token
 * the probe handed it.
 *
 * A failed attempt says the same thing whether the password was wrong or the surface
 * is not enabled — the server does not distinguish, so neither does the copy.
 */
export function AdminLogin({
  locale,
  csrfToken,
  onSignedIn,
}: {
  locale: Locale;
  csrfToken: string;
  onSignedIn: (session: AdminSessionResponse) => void;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <form
      className="mx-auto max-w-md space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setFailed(false);
        logIn(password, csrfToken)
          .then((session) => {
            setPassword("");
            onSignedIn(session);
          })
          .catch(() => setFailed(true))
          .finally(() => setPending(false));
      }}
    >
      <div className="space-y-2">
        <label
          htmlFor="admin-password"
          className="block font-mono text-[11px] uppercase tracking-wide"
        >
          {t(locale, "adminPasswordLabel")}
        </label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          data-testid="admin-password"
          className="w-full rounded-lg border border-rule bg-card px-3 py-2 text-sm"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <button
        type="submit"
        data-testid="admin-sign-in"
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        disabled={pending || password.length === 0}
      >
        {t(locale, "adminSignIn")}
      </button>
      {failed && (
        <p role="alert" data-testid="admin-login-error" className="text-sm text-muted-foreground">
          {t(locale, "adminWrongPassword")}
        </p>
      )}
    </form>
  );
}
