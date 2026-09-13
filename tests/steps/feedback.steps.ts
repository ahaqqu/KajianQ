import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

/**
 * Feedback BDD (#13). All /v1/* traffic is intercepted with fixtures — zero
 * LLM spend in CI. The POST /v1/feedback interception captures the request
 * body so each scenario asserts the ANCHOR the client sent: a thumb carries
 * the answer rating with no anchor; a Trace-panel flag carries the chunk id;
 * a citation-sheet flag carries the citation label. The wire shapes mirror
 * the shared @app/contracts feedback contract the route validates.
 */

const { When, Then } = createBdd();

const SESSION = { userId: "u1", sessionId: "sess-e2e", token: "tok-e2e", expiresAt: 1 };

const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";

const ANSWER_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-live","traceId":"tr-live"}\n\n',
  "event: delta\ndata: Allah Mahahidup sebagaimana firman-Nya ",
  `event: delta\ndata: [QS. 2:255].\ndata: \ndata: ${DISCLAIMER}\n\n`,
  'event: citations\ndata: {"messageId":"m-live","refusal":false,"dhaifWarning":false,"citations":[{"label":"QS. 2:255","arabic":"اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ","translation":"Allah, tidak ada tuhan selain Dia.","machineTranslated":true,"source":"Al-Baqarah"}]}\n\n',
  'event: trace\ndata: {"messageId":"m-live","sources":[{"id":"chunk-1","source":"Al-Baqarah"}],"technical":{"intent":"dalil_umum","subQueries":["apa itu ayat kursi"],"chunks":[{"id":"chunk-1","source":"Al-Baqarah","score":0.03125}],"models":["router-stub","generator-stub"]}}\n\n',
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
    feedbackBodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({
      json: { id: "fb-e2e", messageId: "m-live", rating: null, anchor: null, status: "pending" },
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
  expect(typeof body.messageId).toBe("string");
  expect((body.messageId as string).length).toBeGreaterThan(0);
});

Then("the feedback bar thanks me", async ({ page }) => {
  await expect(page.getByTestId("feedback-thanks").last()).toBeVisible();
});

Then("the flag carries the chunk reference and the reason category", async () => {
  expect(feedbackBodies).toHaveLength(1);
  const anchor = (feedbackBodies[0] ?? {})["anchor"] as Record<string, unknown>;
  expect(anchor).toEqual({ type: "chunk", category: "irrelevant_chunk", id: "chunk-1" });
  expect(feedbackBodies[0]?.["rating"]).toBeUndefined();
});

Then("the flag button confirms the report", async ({ page }) => {
  await expect(page.getByTestId("trace-flag-chunk-1-sent")).toBeVisible();
});

Then("the flag carries the citation label and the reason category", async () => {
  expect(feedbackBodies).toHaveLength(1);
  const anchor = (feedbackBodies[0] ?? {})["anchor"] as Record<string, unknown>;
  expect(anchor).toEqual({ type: "citation", category: "wrong_citation", id: "QS. 2:255" });
});
