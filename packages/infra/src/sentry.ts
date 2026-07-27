/** Sentry facade — no-ops when DSN missing (graceful degrade). */
export type SentryLike = {
  captureException(err: unknown): void;
  captureMessage(msg: string): void;
};

export function createSentry(dsn: string | undefined): SentryLike {
  if (!dsn) {
    return {
      captureException() {},
      captureMessage() {},
    };
  }
  // Real @sentry/* wiring is optional; DSN present marks integration ready.
  return {
    captureException(err) {
      // eslint-disable-next-line no-console -- boundary sink when SDK not bundled
      console.log(JSON.stringify({ level: "error", msg: "sentry", err: String(err) }));
    },
    captureMessage(msg) {
      // eslint-disable-next-line no-console -- boundary sink when SDK not bundled
      console.log(JSON.stringify({ level: "info", msg: "sentry", text: msg }));
    },
  };
}
