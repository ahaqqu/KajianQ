import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Chat UI BDD (#11). All /v1/* traffic is intercepted with fixture streams —
 * zero LLM spend in CI (plan decision 4); the live path stays covered by
 * eval:smoke in the Staging workflow. The fixtures mirror the wire contract
 * (ADR-0034 + ADR-0040 + #12): meta → delta(s) → citations → trace → done.
 */

const { When, Then } = createBdd();

const SESSION = { userId: "u1", sessionId: "sess-e2e", token: "tok-e2e", expiresAt: 1 };

const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";

const ANSWER_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-live","traceId":"tr-live"}\n\n',
  "event: delta\ndata: Allah Mahahidup sebagaimana firman-Nya ",
  // Multi-line payloads ride one `data:` line per raw line (the route's
  // sseFrame escaping) — a literal blank line would terminate the frame.
  `event: delta\ndata: [QS. 2:255].\ndata: \ndata: ${DISCLAIMER}\n\n`,
  'event: citations\ndata: {"messageId":"m-live","refusal":false,"dhaifWarning":false,"citations":[{"label":"QS. 2:255","arabic":"اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ","translation":"Allah, tidak ada tuhan selain Dia.","machineTranslated":true,"source":"Al-Baqarah"}]}\n\n',
  // The routing block also carries the reviewer's N2 shape: the route selected
  // quran + hadith AND the run gave the source dimension up, so the row above
  // the "given up" line must name the route's SELECTION — "sources searched"
  // would assert a restriction the search had already dropped.
  'event: trace\ndata: {"messageId":"m-live","sources":[{"id":"chunk-1","source":"Al-Baqarah"}],"technical":{"intent":"ruling","routing":{"sources":["quran","hadith"],"filters":{"grade":["sahih"],"textLayer":["sharh"],"sourceType":["quran","hadith"]},"relaxed":[{"key":"textLayer","values":["sharh"]},{"key":"sourceType","values":["quran","hadith"]}]},"subQueries":["apa itu ayat kursi","QS 2:255 makna"],"chunks":[{"id":"chunk-1","source":"Al-Baqarah","score":0.03125}],"models":["router-stub","generator-stub"]}}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

const DHAIF_WARNING =
  "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";

// #150 — the grounded model spontaneously wraps spans in markdown; the
// fixture mirrors a live staging answer (`**QS. 2:255**` seen 2026-09-13).
const MD_ANSWER =
  "**Ayat Kursi** adalah *ayat takhta* dalam surah Al-Baqarah.\n\n" +
  "- Allah Mahahidup [QS. 2:255]\n- Penjaga segala sesuatu\n\n";

const MD_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-md","traceId":"tr-md"}\n\n',
  `event: delta\ndata: ${MD_ANSWER.replaceAll("\n", "\ndata: ")}\n\n`,
  'event: citations\ndata: {"messageId":"m-md","refusal":false,"dhaifWarning":false,"citations":[{"label":"QS. 2:255","arabic":"اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ","translation":"Allah, tidak ada tuhan selain Dia.","machineTranslated":true,"source":"Al-Baqarah"}]}\n\n',
  `event: done\ndata: {}\n\n`,
].join("");

/**
 * The one DHAIF wire fixture the four dhaif scenarios share (#292, #348, #361
 * and the plain warning): meta → one delta carrying `answer` (one `data:` line
 * per raw line, the route's sseFrame escaping) → the citations frame that
 * flags the warning → done. `slug` names the conversation: its message id is
 * `m-<slug>` and its trace id `tr-<slug>`.
 */
const dhaifFixture = (slug: string, answer: string): string =>
  [
    `event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-${slug}","traceId":"tr-${slug}"}\n\n`,
    `event: delta\ndata: ${answer.replaceAll("\n", "\ndata: ")}\n\n`,
    `event: citations\ndata: {"messageId":"m-${slug}","refusal":false,"dhaifWarning":true,"citations":[{"label":"HR. Malik no. 18","arabic":"حدثنا مالك","machineTranslated":false,"grade":"dhaif","source":"Al-Muwatta"}]}\n\n`,
    "event: done\ndata: {}\n\n",
  ].join("");

const DHAIF_ANSWER = `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DHAIF_WARNING}\n\n${DISCLAIMER}`;

const DHAIF_FIXTURE = dhaifFixture("dhaif", DHAIF_ANSWER);

// #292 — the live p1/p9 shape: the draft already carried its disclaimer, so
// the postprocess appended the dhaif warning and then the MT label, leaving
// `[warning][MT label]` as the tail. The pre-fix peel only looked at the last
// two paragraphs and left the warning in the body, so the card drew the same
// sentence twice.
const DHAIF_MT_ANSWER =
  `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DISCLAIMER}\n\n${DHAIF_WARNING}\n\n` +
  "[Terjemahan mesin — lihat teks Arab asli]";

const DHAIF_MT_FIXTURE = dhaifFixture("dhaif-mt", DHAIF_MT_ANSWER);

// #348 — QA #345 probe p9b: the model repeated the canonical line INSIDE one
// trailing paragraph (one `\n`, not a paragraph break), so the wire carried two
// copies and the page displayed three — both as body prose, plus the flag-driven
// card. The A2 byte-equality gate rejected the paragraph (it is not byte-equal
// to the canonical line), the peel pushed it back into `body`, and
// `split.warning` stayed null while the citations frame still reported
// `dhaifWarning: true`.
const DHAIF_REPEAT_ANSWER =
  `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DISCLAIMER}\n\n` +
  `${DHAIF_WARNING}\n${DHAIF_WARNING}`;

const DHAIF_REPEAT_FIXTURE = dhaifFixture("dhaif-repeat", DHAIF_REPEAT_ANSWER);

// #361 — QA #356 probes p4/p9: the model repeated the canonical line THREE
// times on ONE line, SPACE-SEPARATED (3 × 93 = 281 chars, so the paragraph is
// a single over-cap line). The #348 collapse split on `\n` and never saw a line
// equal to the copy; the paragraph classified as null, which stops the peel, so
// it stayed in `body` as prose while the citations frame still reported
// `dhaifWarning: true` — the wire carried 3, the page displayed 4.
const DHAIF_SPACE_REPEAT_ANSWER =
  `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DISCLAIMER}\n\n` +
  [DHAIF_WARNING, DHAIF_WARNING, DHAIF_WARNING].join(" ");

const DHAIF_SPACE_REPEAT_FIXTURE = dhaifFixture("dhaif-space", DHAIF_SPACE_REPEAT_ANSWER);

const REFUSAL_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-ref","traceId":"tr-ref"}\n\n',
  "event: delta\ndata: tidak menemukan dalil yang memadai\n\n",
  'event: citations\ndata: {"messageId":"m-ref","refusal":true,"dhaifWarning":false,"citations":[]}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

/**
 * #436 — the HYBRID wire shape: a grounded partial answer that quotes a
 * retrieved verse and then continues into the canonical insufficiency sentence
 * plus the disclaimer, while the citations frame carries BOTH the grounded chip
 * and `refusal: true` (the refusal decision the trace records). The server
 * derives that frame from the persisted trace — the derivation, the route and
 * the rehydration entry are pinned in `apps/api/src/lib/chat-citations.test.ts`
 * and the route tests — so what this scenario owns is the user-facing half: the
 * answer's chip survives, and the refusal tail is prose beside it rather than a
 * substitute for the citation sheet.
 */
const HYBRID_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-hybrid","traceId":"tr-hybrid"}\n\n',
  "event: delta\ndata: Allah Mahahidup sebagaimana firman-Nya ",
  `event: delta\ndata: [QS. 2:255].\ndata: \ndata: Untuk bagian lain dari pertanyaan ini saya tidak menemukan dalil yang memadai.\ndata: \ndata: ${DISCLAIMER}\n\n`,
  'event: citations\ndata: {"messageId":"m-hybrid","refusal":true,"dhaifWarning":false,"citations":[{"label":"QS. 2:255","arabic":"اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ","translation":"Allah, tidak ada tuhan selain Dia.","machineTranslated":true,"source":"Al-Baqarah"}]}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

const TRANSCRIPT_FIXTURE = {
  sessionId: "sess-e2e",
  truncated: false,
  messages: [
    { id: "m0", role: "user", content: "Apa itu ayat kursi?", createdAt: 1_700_000_000_000 },
    {
      id: "m1",
      role: "assistant",
      content:
        "Allah Mahahidup [QS. 2:255].\n\nJawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.",
      createdAt: 1_700_000_060_000,
      citations: {
        messageId: "m1",
        refusal: false,
        dhaifWarning: false,
        citations: [
          {
            label: "QS. 2:255",
            arabic: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ",
            translation: "Allah, tidak ada tuhan selain Dia.",
            machineTranslated: true,
            source: "Al-Baqarah",
          },
        ],
      },
      trace: {
        messageId: "m1",
        sources: [{ id: "chunk-1", source: "Al-Baqarah" }],
        technical: {
          intent: "ruling",
          subQueries: ["apa itu ayat kursi"],
          chunks: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
          models: ["router-stub", "generator-stub"],
        },
      },
    },
  ],
};

/**
 * The chat message ceiling (#256), in characters. The e2e layer cannot import
 * `@app/contracts` (workspace packages resolve inside the apps, not at the repo
 * root), so the value is repeated: a drift on either side — the contract's
 * `CHAT_MESSAGE_MAX_LENGTH` or the composer's mirror of it — fails this
 * scenario loudly, which is what pinning it end to end is for.
 */
const CHAT_CEILING = 2000;

/** The over-length probe the QA finding measured (#256): 20,000 characters. */
const QA_PROBE_LENGTH = 20_000;

/**
 * Chat POSTs the fixture route has served in the current scenario (#256), and
 * the raw JSON bodies they carried. Module scope because a scenario's When and
 * Then steps share it, and the suite runs scenarios sequentially
 * (`fullyParallel: false`); both are reset every time a scenario opens the app
 * with fixtures.
 *
 * The bodies are here for the ceiling scenario's wire claim (thermo-review B1):
 * counting POSTs alone cannot say what was sent, and a count of zero cannot
 * fail at all when no send happens.
 */
let chatPosts = 0;
let chatPostBodies: string[] = [];

/**
 * The draft the composer clamped the over-length paste to (#256), captured
 * before the scenario sends it — the send clears the composer, so the wire
 * body is compared against this, not against the (now empty) field.
 */
let clampedDraft = "";

/** Intercept auth + chat endpoints with fixtures, then open the app.
 *
 * `rehydrateStatus` mirrors the rehydration endpoint's documented answer for
 * the scenario's stored session id: 200 with a transcript, or the 404 the API
 * answers for a session it does not have (unknown, foreign, or — #271 — an id
 * the store cannot represent). The fixtures mirror the wire contract; the API
 * side of that contract is pinned by the route tests.
 */
async function openChatWithFixtures(
  page: import("@playwright/test").Page,
  answerFixture: string,
  transcriptFixture: Record<string, unknown> = TRANSCRIPT_FIXTURE,
  rehydrateStatus = 200,
): Promise<void> {
  chatPosts = 0;
  chatPostBodies = [];
  clampedDraft = "";
  await page.route("**/v1/auth/anonymous", (route) => route.fulfill({ json: SESSION }));
  await page.route("**/v1/chat/sessions/*/messages", (route) =>
    rehydrateStatus === 200
      ? route.fulfill({ json: transcriptFixture })
      : route.fulfill({ status: rehydrateStatus, json: { error: "invalid_request" } }),
  );
  await page.route("**/v1/chat", async (route) => {
    chatPosts += 1;
    chatPostBodies.push(route.request().postData() ?? "");
    // A short delay so the staged loading state is observably honest.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: answerFixture,
    });
  });
  // Seed the token before the app boots: one page load per scenario (the
  // dev worker's per-IP rate limiter counts every asset request, and the
  // suite loads the app many times). Each scenario gets a fresh context, so
  // the session id starts unset — a fresh chat — and stays set across the
  // in-scenario reload the rehydration scenario performs.
  await page.addInitScript(() => {
    localStorage.setItem("kajianq.auth.token", "tok-e2e");
  });
  await page.goto("/");
}

When("I open the chat and ask about ayat kursi", async ({ page }) => {
  await openChatWithFixtures(page, ANSWER_FIXTURE);
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
});

When("I ask a question whose answer carries a dhaif hadith", async ({ page }) => {
  await openChatWithFixtures(page, DHAIF_FIXTURE);
  await page.getByTestId("composer").fill("Hadits tentang amalan tertentu?");
  await page.getByTestId("send").click();
});

When(
  "I ask a question whose dhaif answer ends with the machine-translation label",
  async ({ page }) => {
    await openChatWithFixtures(page, DHAIF_MT_FIXTURE);
    await page.getByTestId("composer").fill("Hadits tentang amalan tertentu?");
    await page.getByTestId("send").click();
  },
);

When(
  "I ask a question whose dhaif answer repeats the canonical line in its last paragraph",
  async ({ page }) => {
    await openChatWithFixtures(page, DHAIF_REPEAT_FIXTURE);
    await page.getByTestId("composer").fill("Hadits tentang amalan tertentu?");
    await page.getByTestId("send").click();
  },
);

When(
  "I ask a question whose dhaif answer repeats the canonical line space-separated",
  async ({ page }) => {
    await openChatWithFixtures(page, DHAIF_SPACE_REPEAT_FIXTURE);
    await page.getByTestId("composer").fill("Hadits tentang amalan tertentu?");
    await page.getByTestId("send").click();
  },
);

When("I ask a question whose answer contains markdown", async ({ page }) => {
  await openChatWithFixtures(page, MD_FIXTURE);
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
});

When("I ask something the corpus cannot answer", async ({ page }) => {
  await openChatWithFixtures(page, REFUSAL_FIXTURE);
  await page.getByTestId("composer").fill("Pertanyaan di luar cakupan?");
  await page.getByTestId("send").click();
});

When("I ask a question whose answer answers in part and then refuses", async ({ page }) => {
  await openChatWithFixtures(page, HYBRID_FIXTURE);
  await page.getByTestId("composer").fill("Apa itu ayat kursi, dan kapan Kiamat?");
  await page.getByTestId("send").click();
});

When("I open a chat whose stored transcript was capped", async ({ page }) => {
  // A capped transcript only ever shows through rehydration, and a fresh
  // context boots with no session id (the rehydration query is disabled) —
  // store the session id before the app boots.
  await page.addInitScript(() => {
    localStorage.setItem("kajianq.chat.sessionId", "sess-e2e");
  });
  await openChatWithFixtures(page, ANSWER_FIXTURE, { ...TRANSCRIPT_FIXTURE, truncated: true });
});

Then("the transcript says older messages are not shown", async ({ page }) => {
  await expect(page.getByTestId("transcript-truncated")).toBeVisible();
});

/**
 * #271: the user-facing half of the boundary fix. A stored session id the
 * store cannot represent — the staging probe's own `"en"`, or any older or
 * corrupted localStorage value — is answered by the rehydration endpoint with
 * its documented 404 (never a 500: that is the route test's claim). What the
 * reader experiences is the load-bearing part here: a fresh chat, no error
 * banner, and no replay of the malformed id into a 400 on the next question.
 */
When("I open a chat whose stored session id is malformed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kajianq.chat.sessionId", "en");
  });
  await openChatWithFixtures(page, ANSWER_FIXTURE, TRANSCRIPT_FIXTURE, 404);
});

Then("the app starts a fresh chat without an error", async ({ page }) => {
  // The empty state, not an error card: a session the server does not have is
  // a fresh start (the same posture as a reclaimed session).
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.getByTestId("chat-error")).toHaveCount(0);
  // And the malformed id is cleared, so it cannot be sent again.
  expect(await page.evaluate(() => localStorage.getItem("kajianq.chat.sessionId"))).toBeNull();
});

When("I ask a question in that fresh chat", async ({ page }) => {
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
});

Then("the outgoing chat POST carries no session id", async () => {
  // A real send is the precondition of this claim, as in the ceiling scenario.
  await expect.poll(() => chatPosts).toBe(1);
  const body = JSON.parse(chatPostBodies[0] ?? "{}") as { sessionId?: string };
  // Absent — a new session is minted server-side — never the malformed value.
  expect(body.sessionId).toBeUndefined();
});

When("I open the chat and paste a message longer than the ceiling", async ({ page }) => {
  await openChatWithFixtures(page, ANSWER_FIXTURE);
  // A programmatic fill, not typing (#256): the ceiling has to hold for a
  // pasted value too, which the textarea's maxLength attribute alone does not
  // guarantee — and it is how a crafted page would set the field.
  await page.getByTestId("composer").fill("a".repeat(QA_PROBE_LENGTH));
});

Then("the composer holds the ceiling and says so", async ({ page }) => {
  const composer = page.getByTestId("composer");
  // Clamped to the contract's own ceiling — the draft the reader sees is
  // exactly what the API accepts, not a request that comes back 400.
  clampedDraft = await composer.inputValue();
  expect(clampedDraft.length).toBe(CHAT_CEILING);
  // The hint is the reader's explanation, in the app's language (id by
  // default); the number is Intl-formatted, so build the expectation the same
  // way rather than hardcoding a separator.
  await expect(page.getByTestId("composer-limit")).toContainText(
    new Intl.NumberFormat("id").format(CHAT_CEILING),
  );
});

// B1: the scenario used to stop here and assert `chatPosts === 0`, a claim no
// step could falsify because nothing ever attempted a send (the pre-fix
// scenario passed with the composer's send path mutated to a no-op). The
// property that matters now that the clamp exists is the wire body: press
// Enter and assert what actually left the page.
When("I press Enter to send the clamped draft", async ({ page }) => {
  await page.getByTestId("composer").press("Enter");
});

Then("the outgoing chat POST carries the clamped message, no longer than the ceiling", async () => {
  // A real send is the precondition of this claim: without it the assertion
  // below has nothing to read, so make the counter load-bearing first.
  await expect.poll(() => chatPosts).toBe(1);
  const body = JSON.parse(chatPostBodies[0] ?? "{}") as { message?: string };
  const sent = body.message ?? "";
  // Exactly the clamped draft the composer held — not a truncated copy, not
  // a different string — and at most the contract's ceiling on the wire.
  expect(sent).toBe(clampedDraft);
  expect(sent.length).toBeLessThanOrEqual(CHAT_CEILING);
  // The over-length probe cannot be what was sent.
  expect(sent.length).toBeLessThan(QA_PROBE_LENGTH);
});

Then("I see staged loading while the answer is prepared", async ({ page }) => {
  await expect(page.getByTestId("staged-loading")).toBeVisible();
  await expect(page.getByTestId("staged-loading")).toContainText(
    /Mengambil konteks|Menyusun jawaban/,
  );
});

Then("the answer renders with a citation chip", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant).toContainText("Allah Mahahidup");
  const chip = assistant.getByTestId("citation-chip");
  await expect(chip).toHaveText("[QS. 2:255]");
});

Then("tapping the chip shows the Arabic original", async ({ page }) => {
  await page.getByTestId("citation-chip").last().click();
  const sheet = page.getByTestId("citation-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("citation-arabic")).toContainText("اللَّهُ");
  await expect(sheet.getByTestId("citation-translation")).toBeVisible();
  await expect(sheet.getByTestId("citation-mt-label")).toBeVisible();
  await expect(sheet.getByTestId("citation-source")).toHaveText("Al-Baqarah");
});

Then("the disclaimer renders as a distinct footer", async ({ page }) => {
  const disclaimer = page.getByTestId("ulama-disclaimer").last();
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText("bukan fatwa");
});

Then("the dhaif warning renders as a warning card with the grade badge", async ({ page }) => {
  await expect(page.getByTestId("dhaif-warning").last()).toBeVisible();
  await page.getByTestId("citation-chip").last().click();
  const sheet = page.getByTestId("citation-sheet");
  await expect(sheet.getByTestId("grade-badge")).toHaveText("dhaif");
});

Then("the dhaif warning renders exactly once beside the MT label", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant.getByTestId("dhaif-warning")).toHaveCount(1);
  const text = (await assistant.textContent()) ?? "";
  // The canonical sentence appears once — not once as prose and once as card.
  await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
  // The MT label is provenance, not a warning: it still renders, once.
  await expect(text.split("Terjemahan mesin").length - 1).toBe(1);
  // The disclaimer that the draft already carried still renders as a footer.
  await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
});

Then("the dhaif warning renders exactly once despite the repeated line", async ({ page }) => {
  // Mirrors how QA measured it on staging: a DOM count on the assistant
  // article. Pre-fix this read 3 — both copies as one prose paragraph, plus the
  // flag-driven card — while the wire had carried 2.
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant.getByTestId("dhaif-warning")).toHaveCount(1);
  const text = (await assistant.textContent()) ?? "";
  await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
  // The repeat paragraph is consumed by the card, so the answer text itself
  // still renders and the disclaimer still reaches its footer.
  await expect(assistant).toContainText("Hadits tersebut diriwayatkan");
  await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
});

Then(
  "the dhaif warning renders exactly once despite the space-separated repeat",
  async ({ page }) => {
    // The same DOM count QA ran on staging (probe p4/p9). Pre-fix this read 4 —
    // three copies in one prose paragraph, plus the flag-driven card — while
    // the wire had carried 3.
    const assistant = page.getByTestId("message-assistant").last();
    await expect(assistant.getByTestId("dhaif-warning")).toHaveCount(1);
    const text = (await assistant.textContent()) ?? "";
    await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
    // The paragraph is consumed by the card, so the answer text itself still
    // renders and the disclaimer — one paragraph left of the repeat — still
    // reaches its footer instead of being stranded in the body.
    await expect(assistant).toContainText("Hadits tersebut diriwayatkan");
    await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
  },
);

Then(
  "the answer renders bold, emphasis, and list items with no literal markdown",
  async ({ page }) => {
    const assistant = page.getByTestId("message-assistant").last();
    await expect(assistant.locator("strong")).toHaveText("Ayat Kursi");
    await expect(assistant.locator("em")).toHaveText("ayat takhta");
    const items = assistant.locator("li");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("Allah Mahahidup");
    // The chip still resolves from the structured frame, inside the list item.
    await expect(assistant.getByTestId("citation-chip")).toHaveText("[QS. 2:255]");
    await expect(assistant).not.toContainText("**");
    await expect(assistant).not.toContainText("*ayat takhta*");
  },
);

Then("the refusal renders as a plain card with no citation chips", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant).toContainText("tidak menemukan dalil yang memadai");
  await expect(page.getByTestId("citation-chip")).toHaveCount(0);
  await expect(page.getByTestId("dhaif-warning")).toHaveCount(0);
});

Then("the hybrid answer renders its grounded citation chip", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  // The partial answer and the grounded verse it quotes are what the reader
  // sees — one chip, resolved from the frame (#436).
  await expect(assistant).toContainText("Allah Mahahidup");
  await expect(assistant.getByTestId("citation-chip")).toHaveText("[QS. 2:255]");
  // ... and the refusal tail is still there, as prose in the same card.
  await expect(assistant).toContainText("tidak menemukan dalil yang memadai");
  await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
  await expect(page.getByTestId("dhaif-warning")).toHaveCount(0);
});

Then("reloading restores the full transcript", async ({ page }) => {
  await page.reload();
  await expect(page.getByTestId("message-user")).toBeVisible();
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant).toContainText("Allah Mahahidup");
  await expect(assistant.getByTestId("citation-chip")).toHaveText("[QS. 2:255]");
});

Then("the Trace panel is available from the rehydrated transcript", async ({ page }) => {
  // The rehydrated assistant turn carries the same trace frame the live
  // stream sent (#12) — the panel is a first-class part of the transcript.
  await expect(page.getByTestId("trace-toggle").last()).toBeVisible();
});

When("I expand the answer's Trace", async ({ page }) => {
  await page.getByTestId("trace-toggle").last().click();
  await expect(page.getByTestId("trace-body")).toBeVisible();
});

When("I open the Trace's technical details", async ({ page }) => {
  await page.getByTestId("trace-tech-toggle").last().click();
});

Then("I see the sources consulted with no technical detail", async ({ page }) => {
  // The top layer is readable by a non-technical user: the source works, no
  // scores, no machinery (ADR-0007 — plain language first).
  const panel = page.getByTestId("trace-body");
  await expect(panel.getByTestId("trace-sources")).toContainText("Al-Baqarah");
  await expect(panel.getByTestId("trace-score")).toHaveCount(0);
  await expect(panel.getByTestId("trace-technical")).toHaveCount(0);
  await expect(panel.getByTestId("trace-models")).toHaveCount(0);
});

Then(
  "I see the router intent, the routing decision, sub-queries, retrieval scores, and model identity",
  async ({ page }) => {
    const tech = page.getByTestId("trace-technical");
    await expect(tech).toBeVisible();
    await expect(tech.getByTestId("trace-intent")).toContainText("ruling");
    await expect(tech.getByTestId("trace-subqueries")).toContainText("ayat kursi");
    // Scores format through Intl (0.03125 → "0,0313" in the id locale,
    // "0.0313" in en) — assert the rounded digits, not the separator.
    await expect(tech.getByTestId("trace-score").first()).toContainText(/0[.,]0313/);
    await expect(tech.getByTestId("trace-models")).toContainText("router-stub");
    // The routing decision (#15) rides the same frame: which sources the route
    // selected and with which filters, projected from the persisted trace —
    // the user-visible half of "the trace shows routing decisions".
    //
    // The row is labelled for the route's DECISION, not for a search that ran
    // (N2): this run gave `sourceType` up (the "given up" row asserts it below),
    // so every source was searched, and a "sources searched: quran · hadith" row
    // would have been false — two lines of the same block contradicting.
    await expect(tech.getByTestId("trace-routing")).toContainText("Sumber dipilih");
    await expect(tech.getByTestId("trace-routing-sources")).toContainText("quran");
    await expect(tech.getByTestId("trace-routing-sources")).toContainText("hadith");
    await expect(tech.getByTestId("trace-routing-filters")).toContainText("grade: sahih");
    // ... and the filters the run GAVE UP, so a hint the corpus cannot serve
    // (the `textLayer` hint here, the `principleTags` hint for the missing
    // Principle Index #16 in the live path) is not displayed as one that ran.
    await expect(tech.getByTestId("trace-routing-relaxed")).toContainText("textLayer: sharh");
  },
);

Then("the chat page has no serious accessibility violations", async ({ page }) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map(
      (v) =>
        `${v.impact}: ${v.id} — ${v.help} @ ${v.nodes.map((n) => n.target.join(",")).join(" | ")}`,
    ),
  ).toEqual([]);
});
