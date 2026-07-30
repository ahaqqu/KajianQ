import * as Sentry from "@sentry/react";

/**
 * Errors-only Sentry for the PWA. No-op unless VITE_SENTRY_DSN is set at
 * build time — with no DSN the SDK is never initialized and nothing is
 * captured. Session Replay is deliberately opt-in (~40 KB gz against the
 * 200 KB budget): add `Sentry.replayIntegration()` plus sample rates here.
 */
export function initSentry(dsn: string | undefined): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
  });
}
