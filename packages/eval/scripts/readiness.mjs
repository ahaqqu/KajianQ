/**
 * readiness.mjs — the post-deploy smoke's readiness gate: wait for the target to
 * be serving, then keep the transport/quality line straight.
 *
 * The policy, and the only place it is decided:
 *
 * 1. **Readiness before the sample.** Before the first question the smoke polls
 *    `GET /v1/health` until it answers 2xx, within a fixed budget: at most
 *    READINESS_BUDGET_MS of wall clock, READINESS_INTERVAL_MS between attempts,
 *    READINESS_REQUEST_TIMEOUT_MS per request. An exhausted budget fails the run
 *    with a `readiness:` message **before any question is asked** — nothing is
 *    sampled, nothing is skipped, nothing is spent. This is the wait the deploy's
 *    restart does not provide: `deploy.sh` restarts `kajianq-api`, checks
 *    `is-active` (unit state, not HTTP), and makes one `/v1/health` request; the
 *    seconds after it are exactly when a proxy can still answer 502.
 *
 * 2. **A rejection is not an answer.** A `/v1/chat` round-trip that ends without a
 *    response — the connection failed before headers, or the edge rejected it
 *    with 502/503/504 — is readiness-class on ANY question, not only the first:
 *    no answer exists to judge and nothing was spent, so it is transport, not
 *    quality. The gate retries it with exponential backoff (CHAT_RETRY_BACKOFF_MS
 *    doubling per retry) out of ONE per-run budget of CHAT_RETRY_BUDGET retries,
 *    shared by every question; when that budget is spent the run's verdict is a
 *    `readiness:` failure naming the question and the last cause, never a bare
 *    skip. The single budget is what keeps a flapping edge from looping: every
 *    retry any question spends comes out of the same three.
 *
 *    This is the wait the `/v1/health` poll cannot give. The poll can be green
 *    while `/v1/chat` still rejects — they share the nginx upstream, but the app
 *    accepts a chat POST only once its own routes are serving — so a rejection
 *    after an answered question is the same restart window, not a mid-run outage.
 *    The wait does not cover a request whose response headers arrived and whose
 *    stream then broke: the app accepted the request and may already have paid
 *    for the turn, so that is answered-then-failed — a real failure, never
 *    retried, because a retry would abandon a spent turn the run never bills. Nor
 *    does it cover a 4xx or 500: the app answered, so it is quality, and retrying
 *    it would hide the defect the eval exists to catch. A target that outlasts
 *    the per-run budget reds the run as readiness: the wait is bounded, not a
 *    guarantee of recovery.
 *
 * 3. **Skipped stays honest.** Any skip still fails the run (`exitPolicy` in
 *    `eval-cli.mjs`). A skip means a question could not be measured: a
 *    readiness-class failure once the run's retries are spent (the verdict is
 *    then the `readiness:` failure, and every unasked question carries a skip
 *    row too), or a real failure after the target answered — a broken stream, a
 *    4xx/5xx that is not a restart rejection, a failed trace read. It never means
 *    "the smoke sampled a restart window and moved on".
 *
 * Why this lives in `scripts/` and not in the engine: the engine (`@app/eval`)
 * measures the target it is given, and `eval:run` is operator-invoked against a
 * target already chosen. Waiting out a deploy's restart window is the deployed
 * smoke's own composition concern.
 *
 * Every knob is injectable (fetch, clock, sleep, log) so a stub server can pin the
 * policy without real waiting or a real vendor.
 */

import { ChatTransportError } from "@app/eval";

/** Wall clock the smoke will spend waiting for `/v1/health` before it gives up. */
export const READINESS_BUDGET_MS = 60_000;

/** Pause between two readiness attempts. */
export const READINESS_INTERVAL_MS = 3_000;

/** Per-request timeout, so one hung request cannot swallow the whole budget. */
export const READINESS_REQUEST_TIMEOUT_MS = 5_000;

/** Retries the whole run may spend on readiness-class `/v1/chat` failures. */
export const CHAT_RETRY_BUDGET = 3;

/** First chat-readiness backoff, doubled per retry (2 s, 4 s, 8 s). */
export const CHAT_RETRY_BACKOFF_MS = 2_000;

/** The route the readiness poll reads. */
export const HEALTH_PATH = "/v1/health";

/** The edge statuses that mean "not serving yet", never "answered badly". */
const READINESS_STATUSES = new Set([502, 503, 504]);

/** Thrown when the target did not become ready: the deploy has not landed yet. */
export class ReadinessError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadinessError";
  }
}

/**
 * Whether a transport error says "the target is not available" rather than
 * "the answer was wrong". Only a failure that never got a response qualifies: a
 * failed connection (`connect` phase) or an edge rejection (`response` phase,
 * 502/503/504). A stream that broke after the headers is `stream` phase — the app
 * accepted the request — so it is not readiness.
 */
export function isReadinessClassError(err) {
  if (!(err instanceof ChatTransportError)) return false;
  if (err.phase === "connect") return true;
  return err.phase === "response" && err.status !== null && READINESS_STATUSES.has(err.status);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The cause text of anything a `catch` can hand us, bounded by the caller's log. */
function causeText(err) {
  if (err instanceof Error) return err.message === "" ? err.name : err.message;
  return String(err);
}

/** Release a failed response's body; an unconsumed body holds the connection. */
async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The body is not worth failing the readiness poll over.
  }
}

/**
 * Poll `GET /v1/health` until it answers 2xx, or throw `ReadinessError` once the
 * budget is spent. Returns the attempts made and the wall clock waited, so the
 * caller can print the wait it actually paid instead of the one it configured.
 */
export async function waitForReadiness({
  baseUrl,
  budgetMs = READINESS_BUDGET_MS,
  intervalMs = READINESS_INTERVAL_MS,
  requestTimeoutMs = READINESS_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = Date.now,
  log = console.log,
}) {
  const url = `${baseUrl.replace(/\/$/, "")}${HEALTH_PATH}`;
  const startedAt = now();
  let attempts = 0;
  let lastCause = "no attempt completed";

  for (;;) {
    const remainingMs = budgetMs - (now() - startedAt);
    if (attempts > 0 && remainingMs <= 0) break;
    attempts += 1;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        // Clipped to what is left of the budget, so the last request cannot
        // overrun the wait the policy states.
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
      });
      if (res.ok) {
        const waitedMs = now() - startedAt;
        log(
          `readiness: ${HEALTH_PATH} returned ${res.status} on attempt ${attempts} after ${waitedMs} ms`,
        );
        return { attempts, waitedMs };
      }
      lastCause = `${HEALTH_PATH} returned ${res.status}`;
      await discardBody(res);
    } catch (err) {
      lastCause = `${HEALTH_PATH} request failed: ${causeText(err)}`;
    }

    const pauseMs = Math.min(intervalMs, Math.max(0, budgetMs - (now() - startedAt)));
    if (pauseMs === 0) break;
    log(`readiness: attempt ${attempts} failed (${lastCause}); retrying in ${pauseMs} ms`);
    await sleep(pauseMs);
  }

  throw new ReadinessError(
    `readiness: ${HEALTH_PATH} did not return 2xx within ${budgetMs} ms (${attempts} ${
      attempts === 1 ? "attempt" : "attempts"
    }); last: ${lastCause}`,
  );
}

/**
 * Wrap a transport so a readiness-class failure on any question — no response
 * headers, or a 502/503/504 edge rejection — is retried out of one per-run
 * budget, then reported as a `ReadinessError`; every other failure passes
 * through untouched.
 *
 * `readinessFailure()` is how the caller tells the run's verdict apart from a
 * skip: it is set only when the run's retry budget is exhausted, and it is the
 * error the run ended on. Once it is set, later questions fail fast with it.
 */
export function createChatReadinessGate(
  transport,
  {
    retries = CHAT_RETRY_BUDGET,
    backoffMs = CHAT_RETRY_BACKOFF_MS,
    classify = isReadinessClassError,
    sleep = defaultSleep,
    log = console.log,
  } = {},
) {
  let retriesSpent = 0;
  let readinessFailure;

  const gated = {
    async ask(question) {
      if (readinessFailure !== undefined) throw readinessFailure;
      for (;;) {
        try {
          return await transport.ask(question);
        } catch (err) {
          if (!classify(err)) throw err;
          if (retriesSpent >= retries) {
            readinessFailure = new ReadinessError(
              `readiness: /v1/chat did not accept question ${question.id} within the run's ${retries} readiness ${
                retries === 1 ? "retry" : "retries"
              }; last: ${causeText(err)}`,
            );
            throw readinessFailure;
          }
          const waitMs = backoffMs * 2 ** retriesSpent;
          retriesSpent += 1;
          log(
            `readiness: /v1/chat retry ${retriesSpent}/${retries} for question ${question.id} — ${causeText(err)}; waiting ${waitMs} ms`,
          );
          await sleep(waitMs);
        }
      }
    },
  };

  return {
    transport: gated,
    /** The readiness failure this run ended on, or `undefined` when it measured its sample. */
    readinessFailure: () => readinessFailure,
    /** How many of the run's retries the questions have spent so far. */
    retriesSpent: () => retriesSpent,
  };
}
