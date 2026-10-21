import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

/**
 * Feedback BDD. All /v1/* traffic is intercepted with fixtures — zero
 * LLM spend in CI. The POST /v1/feedback interception captures the request
 * body so each scenario asserts the ANCHOR the client sent: a thumb carries
 * the answer rating with no anchor; a Trace-panel flag carries the chunk id;
 * a citation-sheet flag carries the citation label. The wire shapes mirror
 * the shared @app/contracts feedback contract the route validates: the stub
 * 404s a message id that is not a uuid, so the fixture cannot drift back to a
 * non-uuid placeholder and still show the sent state.
 */

const { When, Then } = createBdd();

const SESSION = { userId: "u1", sessionId: "sess-e2e", token: "tok-e2e", expiresAt: 1 };

/**
 * The answer's persisted message id, which the stub stream names in `meta`.
 * UUID-shaped, because the real feedback contract (`v.uuid()`) refuses anything
 * else — the fixture must model a value the route would accept.
 */
const STREAM_MESSAGE_ID = "6f1c2a1e-8f3b-4c5d-9e7a-1b2c3d4e5f60";

/** The real route's message-id contract, as the feedback stub enforces it. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";

const ANSWER_FIXTURE = [
  `event: meta\ndata: {"sessionId":"sess-e2e","messageId":"${STREAM_MESSAGE_ID}","traceId":"tr-live"}\n\n`,
  "event: delta\ndata: Allah Mahahidup sebagaimana firman-Nya ",
  `event: delta\ndata: [QS. 2:255].\ndata: \ndata: ${DISCLAIMER}\n\n`,
  `event: citations\ndata: {"messageId":"${STREAM_MESSAGE_ID}","refusal":false,"dhaifWarning":false,"citations":[{"label":"QS. 2:255","arabic":"اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ","translation":"Allah, tidak ada tuhan selain Dia.","machineTranslated":true,"source":"Al-Baqarah"}]}\n\n`,
  `event: trace\ndata: {"messageId":"${STREAM_MESSAGE_ID}","sources":[{"id":"chunk-1","source":"Al-Baqarah"}],"technical":{"intent":"ruling","routing":{"sources":[],"filters":{}},"subQueries":["apa itu ayat kursi"],"chunks":[{"id":"chunk-1","source":"Al-Baqarah","score":0.03125}],"models":["router-stub","generator-stub"]}}\n\n`,
  "event: done\ndata: {}\n\n",
].join("");

/** The captured /v1/feedback request bodies, in send order. */
let feedbackBodies: Record<string, unknown>[] = [];

async function openChatWithFixtures(page: import("@playwright/test").Page): Promise<void> {
  feedbackBodies = [];
  await page.route("**/v1/auth/anonymous", (route) => route.fulfill({ json: SESSION }));
  await page.route("**/v1/chat/sessions/*/messages", (route) =>
    route.fulfill({
      json: {
        sessionId: "sess-e2e",
        truncated: false,
        messages: [],
      },
    }),
  );
  await page.route("**/v1/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ANSWER_FIXTURE,
    });
  });
  await page.route("**/v1/feedback", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    feedbackBodies.push(body);
    // The real route refuses a non-uuid before the store and 404s an id that
    // names no row. The stub enforces the shape so the fixture stays a value
    // the route would accept; the exact-id assertions catch a uuid placeholder.
    if (typeof body["messageId"] !== "string" || !UUID_SHAPE.test(body["messageId"])) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    await route.fulfill({
      json: {
        id: "fb-e2e",
        messageId: STREAM_MESSAGE_ID,
        rating: null,
        anchor: null,
        status: "pending",
      },
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("kajianq.auth.token", "tok-e2e");
  });
  await page.goto("/");
}

When("I ask about ayat kursi with feedback capture", async ({ page }) => {
  await openChatWithFixtures(page);
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
});

When("I thumb the answer up", async ({ page }) => {
  await page.getByTestId("feedback-up").last().click();
});

When("I expand the answer's Trace for feedback", async ({ page }) => {
  await page.getByTestId("trace-toggle").last().click();
  await expect(page.getByTestId("trace-body")).toBeVisible();
});

When("I flag the consulted source as irrelevant", async ({ page }) => {
  await page.getByTestId("trace-flag-chunk-1").click();
});

When("I flag the citation as wrong", async ({ page }) => {
  await page.getByTestId("flag-citation").click();
});

Then("the thumbs carry my rating and anchor the answer", async () => {
  expect(feedbackBodies).toHaveLength(1);
  const body = feedbackBodies[0] ?? {};
  expect(body.rating).toBe("up");
  expect(body.anchor).toBeUndefined();
  // The live answer is addressed by the streamed `meta.messageId` — the persisted
  // chat message id — not a client-local key (ADR-0056).
  expect(body.messageId).toBe(STREAM_MESSAGE_ID);
});

Then("the feedback bar thanks me", async ({ page }) => {
  await expect(page.getByTestId("feedback-thanks").last()).toBeVisible();
});

Then("the flag carries the chunk reference and the reason category", async () => {
  expect(feedbackBodies).toHaveLength(1);
  const anchor = (feedbackBodies[0] ?? {})["anchor"] as Record<string, unknown>;
  expect(anchor).toEqual({ type: "chunk", category: "irrelevant_chunk", id: "chunk-1" });
  expect(feedbackBodies[0]?.["rating"]).toBeUndefined();
  // A flag from the live Trace panel names the same persisted message.
  expect(feedbackBodies[0]?.["messageId"]).toBe(STREAM_MESSAGE_ID);
});

Then("the flag button confirms the report", async ({ page }) => {
  await expect(page.getByTestId("trace-flag-chunk-1-sent")).toBeVisible();
});

Then("the flag carries the citation label and the reason category", async () => {
  expect(feedbackBodies).toHaveLength(1);
  const anchor = (feedbackBodies[0] ?? {})["anchor"] as Record<string, unknown>;
  expect(anchor).toEqual({ type: "citation", category: "wrong_citation", id: "QS. 2:255" });
});
