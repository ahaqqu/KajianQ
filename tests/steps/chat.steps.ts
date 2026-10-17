import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Chat UI BDD. All /v1/* traffic is intercepted with fixture streams — zero LLM
 * spend in CI; the live path stays covered by eval:smoke in the Staging
 * workflow. The fixtures mirror the wire contract: meta → delta(s) → citations
 * → trace → done.
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
  // The route selected quran + hadith and then gave the source dimension up, so
  // its row names the route's SELECTION, not a restriction the search dropped.
  'event: trace\ndata: {"messageId":"m-live","sources":[{"id":"chunk-1","source":"Al-Baqarah"}],"technical":{"intent":"ruling","routing":{"sources":["quran","hadith"],"filters":{"grade":["sahih"],"textLayer":["sharh"],"sourceType":["quran","hadith"]},"relaxed":[{"key":"textLayer","values":["sharh"]},{"key":"sourceType","values":["quran","hadith"]}]},"subQueries":["apa itu ayat kursi","QS 2:255 makna"],"chunks":[{"id":"chunk-1","source":"Al-Baqarah","score":0.03125}],"models":["router-stub","generator-stub"]}}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

const DHAIF_WARNING =
  "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";

// The grounded model wraps its citation spans in markdown, so this fixture does.
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
 * The one DHAIF wire fixture the dhaif scenarios share: meta → one delta carrying
 * `answer` (one `data:` line per raw line) → the citations frame that flags the
 * warning → done. `slug` sets the message id `m-<slug>` and trace id `tr-<slug>`.
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

// The draft already carries its disclaimer, so the postprocess leaves
// `[warning][MT label]` as the tail.
const DHAIF_MT_ANSWER =
  `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DISCLAIMER}\n\n${DHAIF_WARNING}\n\n` +
  "[Terjemahan mesin — lihat teks Arab asli]";

const DHAIF_MT_FIXTURE = dhaifFixture("dhaif-mt", DHAIF_MT_ANSWER);

// The canonical line repeated inside ONE trailing paragraph — a single `\n`, not
// a paragraph break — so that paragraph carries two copies at once.
const DHAIF_REPEAT_ANSWER =
  `Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n${DISCLAIMER}\n\n` +
  `${DHAIF_WARNING}\n${DHAIF_WARNING}`;

const DHAIF_REPEAT_FIXTURE = dhaifFixture("dhaif-repeat", DHAIF_REPEAT_ANSWER);

// The same repeat on ONE line, SPACE-SEPARATED: a single over-cap line that no
// `\n` split can see.
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
 * The CONTENT-FREE DECLINE wire shape: the run answered from the product's
 * canned copy because the message carried no question, so the stream carries
 * that copy and the frame carries `refusal: true` with nothing cited — the same
 * shape a refusal reaches the client with, because both are the product's own
 * text rather than a draft.
 */
const DECLINE_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-decline","traceId":"tr-decline"}\n\n',
  "event: delta\ndata: Mohon maaf, kami tidak menemukan pertanyaan pada pesan Anda.\n\n",
  'event: citations\ndata: {"messageId":"m-decline","refusal":true,"dhaifWarning":false,"citations":[]}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

/**
 * The HYBRID wire shape: a grounded partial answer that quotes a retrieved verse
 * and then continues into the canonical insufficiency sentence plus the
 * disclaimer, while the citations frame carries BOTH the grounded chip and
 * `refusal: true`, the refusal decision the trace records.
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
 * The chat message ceiling, in characters. The e2e layer cannot import
 * `@app/contracts` (workspace packages resolve inside the apps), so the value is
 * repeated here: a drift against the contract fails the ceiling scenario loudly.
 */
const CHAT_CEILING = 2000;

/** The over-length probe: 20,000 characters. */
const QA_PROBE_LENGTH = 20_000;

/**
 * Chat POSTs the fixture route has served in the current scenario, and the raw
 * JSON bodies they carried. Module scope because a scenario's When and Then
 * steps share it and the suite runs scenarios sequentially
 * (`fullyParallel: false`); both are reset every time a scenario opens the app
 * with fixtures. The bodies let the ceiling scenario assert what actually left
 * the page, which a POST count alone cannot say.
 */
let chatPosts = 0;
let chatPostBodies: string[] = [];

/**
 * The draft the composer clamped the over-length paste to, captured before the
 * send clears the composer — the wire body is compared against this, not against
 * the now-empty field.
 */
let clampedDraft = "";

/** Intercept auth + chat endpoints with fixtures, then open the app.
 *
 * `rehydrateStatus` mirrors the rehydration endpoint's documented answer for the
 * scenario's stored session id: 200 with a transcript, or the 404 the API answers
 * for a session it does not have — unknown, foreign, or unrepresentable.
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
  // Seed the token before the app boots: the per-IP rate limiter counts every
  // asset request. Each fresh context starts with no session id — a fresh chat —
  // and keeps it across the in-scenario reload the rehydration scenario performs.
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

When("I send a message that is not a question", async ({ page }) => {
  await openChatWithFixtures(page, DECLINE_FIXTURE);
  // The composer sends the content-free shape verbatim: the client does not
  // judge it, the server's route gate does.
  await page.getByTestId("composer").fill("\u200b\u200d\u200b");
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
 * A stored session id the store cannot represent — any older or corrupted
 * localStorage value — gets the rehydration endpoint's documented 404, never a
 * 500 (the route test's claim). The load-bearing part is what the reader sees: a
 * fresh chat, no error banner, and no replay of the malformed id into a 400.
 */
When("I open a chat whose stored session id is malformed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kajianq.chat.sessionId", "en");
  });
  await openChatWithFixtures(page, ANSWER_FIXTURE, TRANSCRIPT_FIXTURE, 404);
});

Then("the app starts a fresh chat without an error", async ({ page }) => {
  // The empty state, not an error card: a session the server does not have is a fresh start.
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.getByTestId("chat-error")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("kajianq.chat.sessionId"))).toBeNull();
});

When("I ask a question in that fresh chat", async ({ page }) => {
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
});

Then("the outgoing chat POST carries no session id", async () => {
  // A real send is the precondition: without it the assertion below has nothing to read.
  await expect.poll(() => chatPosts).toBe(1);
  const body = JSON.parse(chatPostBodies[0] ?? "{}") as { sessionId?: string };
  // Absent — a new session is minted server-side — never the malformed value.
  expect(body.sessionId).toBeUndefined();
});

When("I open the chat and paste a message longer than the ceiling", async ({ page }) => {
  await openChatWithFixtures(page, ANSWER_FIXTURE);
  // A programmatic fill, not typing: the ceiling has to hold for a pasted value
  // too, which the textarea's maxLength attribute alone does not guarantee.
  await page.getByTestId("composer").fill("a".repeat(QA_PROBE_LENGTH));
});

Then("the composer holds the ceiling and says so", async ({ page }) => {
  const composer = page.getByTestId("composer");
  // Clamped to the contract's own ceiling — the draft the reader sees is
  // exactly what the API accepts, not a request that comes back 400.
  clampedDraft = await composer.inputValue();
  expect(clampedDraft.length).toBe(CHAT_CEILING);
  // The hint is the reader's explanation in the app's language (id by default);
  // the number is Intl-formatted, so build the expectation the same way.
  await expect(page.getByTestId("composer-limit")).toContainText(
    new Intl.NumberFormat("id").format(CHAT_CEILING),
  );
});

When("I press Enter to send the clamped draft", async ({ page }) => {
  await page.getByTestId("composer").press("Enter");
});

Then("the outgoing chat POST carries the clamped message, no longer than the ceiling", async () => {
  // A real send is the precondition: make the counter load-bearing first.
  await expect.poll(() => chatPosts).toBe(1);
  const body = JSON.parse(chatPostBodies[0] ?? "{}") as { message?: string };
  const sent = body.message ?? "";
  // Exactly the clamped draft — not a truncated copy, not a different string —
  // and at most the contract's ceiling on the wire.
  expect(sent).toBe(clampedDraft);
  expect(sent.length).toBeLessThanOrEqual(CHAT_CEILING);
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
  // The canonical sentence appears once, and the MT label is provenance, not a
  // warning: it still renders, once.
  await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
  await expect(text.split("Terjemahan mesin").length - 1).toBe(1);
  await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
});

Then("the dhaif warning renders exactly once despite the repeated line", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  await expect(assistant.getByTestId("dhaif-warning")).toHaveCount(1);
  const text = (await assistant.textContent()) ?? "";
  await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
  await expect(assistant).toContainText("Hadits tersebut diriwayatkan");
  await expect(assistant.getByTestId("ulama-disclaimer")).toHaveCount(1);
});

Then(
  "the dhaif warning renders exactly once despite the space-separated repeat",
  async ({ page }) => {
    const assistant = page.getByTestId("message-assistant").last();
    await expect(assistant.getByTestId("dhaif-warning")).toHaveCount(1);
    const text = (await assistant.textContent()) ?? "";
    await expect(text.split(DHAIF_WARNING).length - 1).toBe(1);
    // The paragraph is consumed by the card: the answer text still renders and the
    // disclaimer, one paragraph left of the repeat, still reaches its footer.
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

Then("the decline renders as a plain card with no citation chips", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  // The decline reaches the page as the settled text plus the frame's own
  // refusal flag, exactly as a refusal does: the client renders the record, it
  // does not reconstruct the answer path. Nothing decorates it — the product
  // rules never ran, because the reviewer never did.
  await expect(assistant).toContainText("tidak menemukan pertanyaan pada pesan Anda");
  await expect(page.getByTestId("citation-chip")).toHaveCount(0);
  await expect(page.getByTestId("dhaif-warning")).toHaveCount(0);
  await expect(page.getByTestId("ulama-disclaimer")).toHaveCount(0);
});

Then("the hybrid answer renders its grounded citation chip", async ({ page }) => {
  const assistant = page.getByTestId("message-assistant").last();
  // The partial answer and the verse it quotes are what the reader sees: one
  // chip, resolved from the frame.
  await expect(assistant).toContainText("Allah Mahahidup");
  await expect(assistant.getByTestId("citation-chip")).toHaveText("[QS. 2:255]");
  // The refusal tail is still there, as prose in the same card.
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
  // The rehydrated assistant turn carries the same trace frame as the live
  // stream: the panel is a first-class part of the transcript.
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
  // scores, no machinery.
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
    // Scores format through Intl, so assert the rounded digits, not the separator.
    await expect(tech.getByTestId("trace-score").first()).toContainText(/0[.,]0313/);
    await expect(tech.getByTestId("trace-models")).toContainText("router-stub");
    // The row is labelled for the route's DECISION, not for a search that ran:
    // this run gave `sourceType` up (asserted below), so every source was
    // searched, and a "sources searched" row would have been false.
    await expect(tech.getByTestId("trace-routing")).toContainText("Sumber dipilih");
    await expect(tech.getByTestId("trace-routing-sources")).toContainText("quran");
    await expect(tech.getByTestId("trace-routing-sources")).toContainText("hadith");
    await expect(tech.getByTestId("trace-routing-filters")).toContainText("grade: sahih");
    // The filters the run GAVE UP, so a hint the corpus cannot serve is not
    // displayed as one that ran.
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
