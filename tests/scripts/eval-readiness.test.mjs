import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIRST_ANSWER_BACKOFF_MS,
  FIRST_ANSWER_RETRIES,
  HEALTH_PATH,
  READINESS_BUDGET_MS,
  READINESS_INTERVAL_MS,
  READINESS_REQUEST_TIMEOUT_MS,
  ReadinessError,
  createFirstAnswerGate,
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
 * no vendor, no store, no waiting. Three cases are the gate's whole contract — a 502
 * storm that clears must pass and say how many attempts it took; a target that stays
 * down must fail as READINESS, before a question is asked; and a 502 after an answer
 * has landed must fail as a real (mid-run) failure, with no retry.
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
 * A number is a status; `"answer"` is a 200 SSE answer.
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
});

describe("the first question — a transport failure is not an eval result", () => {
  it("classifies only a failed connection and 502/503/504 as readiness", () => {
    expect(isReadinessClassError(new ChatTransportError(null, "connection refused"))).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isReadinessClassError(new ChatTransportError(status, "edge"))).toBe(true);
    }
    // A real failure (bad request, auth, an app 500) is never retried: retrying it would
    // hide the defect the eval exists to catch.
    for (const status of [400, 401, 404, 500]) {
      expect(isReadinessClassError(new ChatTransportError(status, "edge"))).toBe(false);
    }
    expect(isReadinessClassError(new Error("eval budget exceeded"))).toBe(false);
  });

  it("retries a first-question 502 with backoff and the run still passes 5/5", async () => {
    // Reject the first two chat requests, then serve: the retry is what turns a
    // restart-window 502 into a green run instead of two skipped questions.
    const target = await startTarget({ chat: [502, 502, "answer"] });
    const waits = [];
    const lines = [];
    const gate = createFirstAnswerGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: (line) => lines.push(line),
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(SAMPLE_SIZE);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gate.readinessFailure()).toBeUndefined();
    expect(waits).toEqual([FIRST_ANSWER_BACKOFF_MS, FIRST_ANSWER_BACKOFF_MS * 2]);
    expect(lines.filter((line) => line.startsWith("readiness: first question"))).toHaveLength(2);
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
    const gate = createFirstAnswerGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps, rows } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);
    const failure = gate.readinessFailure();

    expect(failure).toBeInstanceOf(ReadinessError);
    expect(failure.message).toMatch(
      /^readiness: \/v1\/chat did not accept the first question within 4 attempts; last: \/v1\/chat returned 502/,
    );
    // One retry budget for the run, not one per question: once the target is known
    // dead, the remaining questions fail fast instead of spending another backoff each.
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(
      1 + FIRST_ANSWER_RETRIES,
    );
    expect(waits).toEqual([
      FIRST_ANSWER_BACKOFF_MS,
      FIRST_ANSWER_BACKOFF_MS * 2,
      FIRST_ANSWER_BACKOFF_MS * 4,
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

  it("fails a mid-run 502 without retrying it — a real, red, skipped question", async () => {
    const target = await startTarget({ chat: [200, 502] });
    const waits = [];
    const gate = createFirstAnswerGate(transportTo(target.baseUrl), {
      sleep: recordingSleep(waits),
      log: () => {},
    });
    const { deps } = sampleDeps(gate.transport);

    const result = await runGoldenSet(sample, deps);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(SAMPLE_SIZE - 1);
    expect(waits).toEqual([]);
    expect(target.requests.filter((path) => path === CHAT_PATH)).toHaveLength(SAMPLE_SIZE);
    expect(gate.readinessFailure()).toBeUndefined();
    const skipped = result.results.filter((row) => row.skipped === true);
    for (const row of skipped) {
      expect(row.notes?.[0]).toContain("/v1/chat returned 502");
    }
    expect(
      exitPolicy("eval:smoke", {
        runId: result.runId,
        questionCount: SAMPLE_SIZE,
        result,
      }).message,
    ).toBe(
      `eval:smoke: FAILED — 0 failed, ${SAMPLE_SIZE - 1} skipped. See eval_results for run run-stub.`,
    );
  });

  it("does not treat a first-question 400 as readiness: no retry, a real failure", async () => {
    const target = await startTarget({ chat: [400] });
    const waits = [];
    const gate = createFirstAnswerGate(transportTo(target.baseUrl), {
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

  it("asks the sample through the first-answer gate and reports a readiness failure", () => {
    expect(source).toContain("createFirstAnswerGate(");
    expect(source).toContain("transport: gate.transport");
    // The readiness verdict is printed after the summary, so the evidence block keeps
    // both the run's record and the reason the sample could not start.
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
    expect(FIRST_ANSWER_RETRIES).toBe(3);
    expect(FIRST_ANSWER_BACKOFF_MS).toBe(2_000);
    expect(READINESS_INTERVAL_MS).toBeLessThan(READINESS_BUDGET_MS);
    expect(READINESS_REQUEST_TIMEOUT_MS).toBeLessThan(READINESS_BUDGET_MS);
  });
});
