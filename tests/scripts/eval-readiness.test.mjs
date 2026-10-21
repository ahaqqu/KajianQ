import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAT_RETRY_BACKOFF_MS,
  CHAT_RETRY_BUDGET,
  HEALTH_PATH,
  READINESS_BUDGET_MS,
  READINESS_INTERVAL_MS,
  READINESS_REQUEST_TIMEOUT_MS,
  ReadinessError,
  createChatReadinessGate,
  isReadinessClassError,
  waitForReadiness,
} from "../../packages/eval/scripts/readiness.mjs";
import { exitPolicy } from "../../packages/eval/scripts/eval-cli.mjs";
// Path imports, not the `@app/eval` self-reference the script uses: a file outside a
// workspace package has no scope to resolve that name from. Same module file either
// way, so the error classes the gate checks are the ones the transport throws.
import {
  Budget,
  ChatTransportError,
  postChatSse,
  runGoldenSet,
} from "../../packages/eval/src/index.ts";

/**
 * The post-deploy smoke's readiness gate, exercised against a real stub HTTP server:
 * no vendor, no store, no waiting. The cases are the gate's whole contract — the
 * health poll (a 502 storm that clears must pass and say how many attempts it took;
 * a target that stays down must fail as READINESS before a question is asked; a
 * request that never answers must hit its deadline); the chat retry (a no-response
 * round-trip on any question is retried out of one per-run budget); and the line
 * that is not readiness (a stream broken after its headers, a 4xx/500).
 *
 * The smoke CLI itself cannot be imported here (importing it connects to staging), so
 * its wiring is pinned from its source, the same instrument `eval-staging-harness.test.mjs`
 * uses for the `.mjs` entry points. The gate's policy constants are pinned by value
 * because they ARE the budget the smoke states in its header.
 */

const CHAT_PATH = "/v1/chat";

/** One answer frame set `postChatSse` can consume: meta ids, text, done. */
const SSE_ANSWER = [
  'event: meta\ndata: {"messageId":"m-stub","traceId":"t-stub"}\n\n',
  "event: delta\ndata: a stub answer\n\n",
  "event: done\ndata: {}\n\n",
].join("");

/** The smoke's sample size; the questions are trivial so the subject is the gate. */
const SAMPLE_SIZE = 5;

/**
 * A Golden Set whose questions score 1 on every dimension with an empty trace: with
 * no expected source types and no required citations, recall and citation validity are
 * satisfied by construction, so the gate is the only thing under test.
 */
const sample = {
  id: "smoke-readiness-stub",
  status: "v0-draft",
  questions: Array.from({ length: SAMPLE_SIZE }, (_, i) => ({
    id: `gs-v0-stub-${i}`,
    question: `question ${i}`,
    language: "id",
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "answer",
  })),
};

const openTargets = [];

afterEach(async () => {
  await Promise.all(openTargets.splice(0).map((target) => target.close()));
});

/**
 * A stub target on one `node:http` server. Each route reads a plan: entry N is the
 * action of that route's Nth request, and the last entry sticks once the plan runs
 * out — `[502, 502, 200]` is "reject twice, then serve", `[502]` is "always 502".
 * A number is a status; `"answer"` is a 200 SSE answer; `"hang"` accepts and never
 * answers; `"break-stream"` sends 200 headers and a partial frame, then drops the
 * connection so the consumer sees a broken stream rather than a failed connect.
 */
async function startTarget({ health = [], chat = [] } = {}) {
  const requests = [];
  const counts = new Map();
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(path);
    const seen = counts.get(path) ?? 0;
    counts.set(path, seen + 1);
    const plan = path === HEALTH_PATH ? health : path === CHAT_PATH ? chat : [];
    const action =
      plan.length === 0
        ? path === HEALTH_PATH
          ? 200
          : "answer"
        : plan[Math.min(seen, plan.length - 1)];
    if (action === "answer") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_ANSWER);
      return;
    }
    if (action === "hang") {
      // Accept the request and never write: only the caller's deadline ends it.
      return;
    }
    if (action === "break-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: delta\ndata: partial answer\n\n");
      res.flushHeaders();
      // Let the client hold the headers and the first frame before the drop, so the
      // failure is a broken stream, not a failed connection.
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.writeHead(action, { "content-type": "text/html" });
    res.end(`<html>${action} response</html>`);
  });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  const target = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolveClosed) => server.close(() => resolveClosed()));
    },
  };
  openTargets.push(target);
  return target;
}

/** The staging transport the smoke hands the harness: `postChatSse` over the stub. */
function transportTo(baseUrl) {
  return {
    async ask(question) {
      const reply = await postChatSse({
        baseUrl,
        token: "stub-token",
        question: question.question,
        language: question.language === "en" ? "en" : "id",
      });
      return {
        text: reply.text,
        messageId: reply.messageId,
        traceId: reply.traceId,
        citations: reply.citations,
      };
    },
  };
}

/**
 * The harness's non-store seams: an empty trace and an in-memory ledger, so a run
 * scores and persists without Postgres.
 */
function sampleDeps(transport) {
  const rows = [];
  return {
    rows,
    deps: {
      transport,
      traces: {
        async eventsByMessage() {
          return [];
        },
      },
      ledger: {
        async createRun() {
          return "run-stub";
        },
        async refreshRun() {},
        async saveResult(_runId, questionId, outcome) {
          rows.push({ questionId, outcome });
          return questionId;
        },
      },
      sourceTypeOf: () => undefined,
      budget: new Budget(undefined),
      refusalMarkers: [],
      label: "stub",
    },
  };
}

const recordingSleep = (waits) => async (ms) => {
  waits.push(ms);
};

/**
 * A fake clock whose only passage is the gate's own sleeps, so the readiness budget is
 * exercised in full without spending real wall clock.
 */
function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}

describe("waitForReadiness — the wait before the sample", () => {
  it("waits out a restart-window 502 and reports every retry it made", async () => {
    const target = await startTarget({ health: [502, 502, 200] });
    const waits = [];
    const lines = [];

    const outcome = await waitForReadiness({
      baseUrl: target.baseUrl,
      sleep: recordingSleep(waits),
      log: (line) => lines.push(line),
    });

    expect(outcome.attempts).toBe(3);
    expect(waits).toEqual([READINESS_INTERVAL_MS, READINESS_INTERVAL_MS]);
    expect(target.requests).toEqual([HEALTH_PATH, HEALTH_PATH, HEALTH_PATH]);
    // The retries are reported, not swallowed: the CI log shows the wait that happened.
    expect(lines.filter((line) => line.startsWith("readiness: attempt"))).toHaveLength(2);
    expect(lines.at(-1)).toContain(`readiness: ${HEALTH_PATH} returned 200 on attempt 3`);
  });

  it("fails as READINESS, asking no question, when the target never becomes ready", async () => {
    const target = await startTarget({ health: [502] });
    const clock = fakeClock();

    const err = await waitForReadiness({
      baseUrl: target.baseUrl,
      budgetMs: 900,
      intervalMs: 300,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }).catch((thrown) => thrown);

    expect(err).toBeInstanceOf(ReadinessError);
    expect(err.message).toMatch(
      /^readiness: \/v1\/health did not return 2xx within 900 ms \(\d+ attempts\); last: \/v1\/health returned 502/,
    );
    // The sample was never asked: a red run with no question touched is not a skip.
    expect(target.requests).toEqual([HEALTH_PATH, HEALTH_PATH, HEALTH_PATH]);
    expect(target.requests).not.toContain(CHAT_PATH);
  });

  it("stops at its budget instead of waiting forever on a target that stays 502", async () => {
    const target = await startTarget({ health: [502] });
    const clock = fakeClock();

    await waitForReadiness({
      baseUrl: target.baseUrl,
      budgetMs: 900,
      intervalMs: 300,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }).catch(() => {});

    // The last wait is clipped to the budget, so the poll never oversleeps it.
    expect(clock.now()).toBe(900);
  });

  it("bounds a health request that never answers with the per-request timeout", async () => {
    const target = await startTarget({ health: ["hang"] });
    const startedAt = Date.now();
    const err = await waitForReadiness({
      baseUrl: target.baseUrl,
      budgetMs: 400,
      intervalMs: 100,
      requestTimeoutMs: 150,
      log: () => {},
    }).catch((thrown) => thrown);
    const elapsedMs = Date.now() - startedAt;

    expect(err).toBeInstanceOf(ReadinessError);
    // Two deadline-clipped attempts (0–150 ms, then 250–400 ms). With the request
    // deadline removed the first fetch never settles and this case times out rather
    // than reding the assertion, which is exactly the hang the bound exists to stop.
    expect(err.message).toMatch(/within 400 ms \(2 attempts\)/);
    expect(target.requests).toHaveLength(2);
    expect(elapsedMs).toBeLessThan(1_200);
  });

  it("clips the last request's deadline to what is left of the budget", async () => {
    const target = await startTarget({ health: ["hang"] });
    const startedAt = Date.now();
    const err = await waitForReadiness({
      baseUrl: target.baseUrl,
      budgetMs: 200,
      intervalMs: 100,
      requestTimeoutMs: 30_000,
      log: () => {},
    }).catch((thrown) => thrown);
    const elapsedMs = Date.now() - startedAt;

    expect(err).toBeInstanceOf(ReadinessError);
    // The per-request timeout is far larger than the budget; only the remaining-budget
    // clip ends the single attempt. Dropping the clip makes this fetch outlive the test.
    expect(err.message).toMatch(/within 200 ms \(1 attempt\)/);
    expect(target.requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("the chat readiness gate — a no-response round-trip is not an eval result", () => {
  it("classifies a failed connection and a 502/503/504 rejection as readiness, not a broken stream", () => {
    expect(
      isReadinessClassError(new ChatTransportError(null, "connection refused", "connect")),
    ).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isReadinessClassError(new ChatTransportError(status, "edge", "response"))).toBe(true);
    }
    // A stream that broke after the headers got its response: the app accepted the
    // request and may have spent on the turn. Answered-then-failed, never a retry.
    expect(isReadinessClassError(new ChatTransportError(null, "stream failed", "stream"))).toBe(
      false,
    );
    // A real failure (bad request, auth, an app 500) is never retried: retrying it would
    // hide the defect the eval exists to catch.
    for (const status of [400, 401, 404, 500]) {
      expect(isReadinessClassError(new ChatTransportError(status, "edge", "response"))).toBe(false);
    }
    expect(isReadinessClassError(new Error("eval budget exceeded"))).toBe(false);
  });

  it("retries a first-question 502 with backoff and the run still passes 5/5", async () => {
    // Reject the first two chat requests, then serve: the retry is what turns a
    // restart-window 502 into a green run instead of two skipped questions.
    const target = await startTarget({ chat: [502, 502, "answer"] });
    const waits = [];
    const lines = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: (line) => lines.push(line),
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(SAMPLE_SIZE);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gate.readinessFailure()).toBeUndefined();
    expect(waits).toEqual([CHAT_RETRY_BACKOFF_MS, CHAT_RETRY_BACKOFF_MS * 2]);
    expect(lines.filter((line) => line.startsWith("readiness: /v1/chat retry"))).toHaveLength(2);
    expect(
      exitPolicy("eval:smoke", {
        runId: result.runId,
        questionCount: SAMPLE_SIZE,
        result,
      }),
    ).toEqual({ ok: true, message: "eval:smoke: PASSED" });
  });

  it("fails as READINESS, never as a skip, when the first question is never accepted", async () => {
    const target = await startTarget({ chat: [502] });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps, rows } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);
    const failure = gate.readinessFailure();

    expect(failure).toBeInstanceOf(ReadinessError);
    expect(failure.message).toMatch(
      /^readiness: \/v1\/chat did not accept question gs-v0-stub-0 within the run's 3 readiness retries; last: \/v1\/chat returned 502/,
    );
    // One retry budget for the run, not one per question: once the target is known
    // dead, the remaining questions fail fast instead of spending another backoff each.
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(
      1 + CHAT_RETRY_BUDGET,
    );
    expect(waits).toEqual([
      CHAT_RETRY_BACKOFF_MS,
      CHAT_RETRY_BACKOFF_MS * 2,
      CHAT_RETRY_BACKOFF_MS * 4,
    ]);
    // The ledger still records what could not be measured, and the shared policy is still
    // red — the readiness verdict is what names the cause.
    expect(rows).toHaveLength(SAMPLE_SIZE);
    expect(result.skipped).toBe(SAMPLE_SIZE);
    expect(
      exitPolicy("eval:smoke", {
        runId: result.runId,
        questionCount: SAMPLE_SIZE,
        result,
      }).ok,
    ).toBe(false);
  });

  it("retries a mid-run 502 instead of skipping the question", async () => {
    // The incident's shape: question 1 answered, then the edge rejected questions 2
    // and 3 in turn while `/v1/health` was already green. Both get their retry, so the
    // two 502s that were skips become two answered questions.
    const target = await startTarget({ chat: ["answer", 502, "answer", 502, "answer"] });
    const waits = [];
    const lines = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: (line) => lines.push(line),
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(SAMPLE_SIZE);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gate.readinessFailure()).toBeUndefined();
    expect(waits).toEqual([CHAT_RETRY_BACKOFF_MS, CHAT_RETRY_BACKOFF_MS * 2]);
    expect(lines.filter((line) => line.startsWith("readiness: /v1/chat retry"))).toHaveLength(2);
  });

  it("reds a mid-run 502 as readiness once the run's retries are spent", async () => {
    const target = await startTarget({ chat: ["answer", 502] });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);
    const failure = gate.readinessFailure();

    expect(result.passed).toBe(1);
    expect(result.skipped).toBe(SAMPLE_SIZE - 1);
    expect(waits).toEqual([
      CHAT_RETRY_BACKOFF_MS,
      CHAT_RETRY_BACKOFF_MS * 2,
      CHAT_RETRY_BACKOFF_MS * 4,
    ]);
    expect(failure).toBeInstanceOf(ReadinessError);
    expect(failure.message).toMatch(
      /did not accept question gs-v0-stub-1 within the run's 3 readiness retries; last: \/v1\/chat returned 502/,
    );
    expect(
      exitPolicy("eval:smoke", {
        runId: result.runId,
        questionCount: SAMPLE_SIZE,
        result,
      }).ok,
    ).toBe(false);
  });

  it("shares one retry budget across questions instead of granting three to each", async () => {
    // Three 502s, each followed by an answer, spend the whole run's budget; the fourth
    // 502 has none left, so it reds as readiness without another backoff.
    const target = await startTarget({
      chat: [502, "answer", 502, "answer", 502, "answer", 502],
    });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(3);
    expect(result.skipped).toBe(2);
    expect(waits).toEqual([
      CHAT_RETRY_BACKOFF_MS,
      CHAT_RETRY_BACKOFF_MS * 2,
      CHAT_RETRY_BACKOFF_MS * 4,
    ]);
    expect(gate.retriesSpent()).toBe(CHAT_RETRY_BUDGET);
    expect(gate.readinessFailure()).toBeInstanceOf(ReadinessError);
    // Q1 502→answer, Q2 502→answer, Q3 502→answer, Q4 502 (budget gone), Q5 fails fast.
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(7);
  });

  it("does not retry a stream that breaks after the headers: answered-then-failed", async () => {
    // The 200 headers reached the client, so the app had accepted the request and may
    // already have spent on the turn. Retrying would mask that and leave the abandoned
    // turn's cost unbilled, so it is a real failure with no readiness retry.
    const target = await startTarget({ chat: ["break-stream"] });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps, rows } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(gate.readinessFailure()).toBeUndefined();
    expect(waits).toEqual([]);
    expect(result.skipped).toBe(SAMPLE_SIZE);
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(SAMPLE_SIZE);
    for (const row of rows) {
      expect(row.outcome.notes?.[0]).toContain("stream failed");
    }
  });

  it("keeps the run's budget for a later question after a non-readiness failure", async () => {
    // Question 1 is a 400: a real failure with no retry and no readiness latch. The
    // budget belongs to the run, so question 2's 502 still gets it — a per-question
    // budget would have granted three retries here instead of one shared pool.
    const target = await startTarget({ chat: [400, 502, "answer"] });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(SAMPLE_SIZE - 1);
    expect(result.skipped).toBe(1);
    expect(waits).toEqual([CHAT_RETRY_BACKOFF_MS]);
    expect(gate.readinessFailure()).toBeUndefined();
  });

  it("does not treat a first-question 400 as readiness: no retry, a real failure", async () => {
    const target = await startTarget({ chat: [400] });
    const waits = [];
    const gate = createChatReadinessGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(waits).toEqual([]);
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(SAMPLE_SIZE);
    expect(gate.readinessFailure()).toBeUndefined();
    expect(result.skipped).toBe(SAMPLE_SIZE);
  });
});

describe("the smoke's wiring", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/eval/scripts/eval-smoke.mjs"),
    "utf8",
  );

  it("waits for readiness before the harness bootstrap and before the sample", () => {
    const readinessAt = source.indexOf("await waitForReadiness(");
    const harnessAt = source.indexOf("await createStagingHarness(");
    const sampleAt = source.indexOf("await evalpkg.runGoldenSet(");
    expect(readinessAt).toBeGreaterThan(-1);
    expect(readinessAt).toBeLessThan(harnessAt);
    expect(readinessAt).toBeLessThan(sampleAt);
  });

  it("asks the sample through the chat readiness gate and reports a readiness failure", () => {
    expect(source).toContain("createChatReadinessGate(");
    expect(source).toContain("transport: gate.transport");
    // The readiness verdict is printed after the summary, so the evidence block keeps
    // both the run's record and the reason the sample could not finish.
    expect(source.indexOf("gate.readinessFailure()")).toBeGreaterThan(
      source.indexOf('printSummary("eval:smoke"'),
    );
  });

  it("publishes the budget the header states as the constants the gate enforces", () => {
    // Changing any of these is a policy change, not a tuning knob: the header quotes the
    // budget, and the smoke would otherwise widen its own wait silently.
    expect(READINESS_BUDGET_MS).toBe(60_000);
    expect(READINESS_INTERVAL_MS).toBe(3_000);
    expect(READINESS_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(CHAT_RETRY_BUDGET).toBe(3);
    expect(CHAT_RETRY_BACKOFF_MS).toBe(2_000);
    expect(READINESS_INTERVAL_MS).toBeLessThan(READINESS_BUDGET_MS);
    expect(READINESS_REQUEST_TIMEOUT_MS).toBeLessThan(READINESS_BUDGET_MS);
  });
});
