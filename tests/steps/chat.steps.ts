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
  'event: trace\ndata: {"messageId":"m-live","sources":[{"id":"chunk-1","source":"Al-Baqarah"}],"technical":{"intent":"dalil_umum","subQueries":["apa itu ayat kursi","QS 2:255 makna"],"chunks":[{"id":"chunk-1","source":"Al-Baqarah","score":0.03125}],"models":["router-stub","generator-stub"]}}\n\n',
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

const DHAIF_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-dhaif","traceId":"tr-dhaif"}\n\n',
  `event: delta\ndata: Hadits tersebut diriwayatkan [HR. Malik no. 18].\ndata: \ndata: ${DHAIF_WARNING}\ndata: \ndata: ${DISCLAIMER}\n\n`,
  'event: citations\ndata: {"messageId":"m-dhaif","refusal":false,"dhaifWarning":true,"citations":[{"label":"HR. Malik no. 18","arabic":"حدثنا مالك","machineTranslated":false,"grade":"dhaif","source":"Al-Muwatta"}]}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

const REFUSAL_FIXTURE = [
  'event: meta\ndata: {"sessionId":"sess-e2e","messageId":"m-ref","traceId":"tr-ref"}\n\n',
  "event: delta\ndata: tidak menemukan dalil yang memadai\n\n",
  'event: citations\ndata: {"messageId":"m-ref","refusal":true,"dhaifWarning":false,"citations":[]}\n\n',
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
          intent: "dalil_umum",
          subQueries: ["apa itu ayat kursi"],
          chunks: [{ id: "chunk-1", source: "Al-Baqarah", score: 0.03125 }],
          models: ["router-stub", "generator-stub"],
        },
      },
    },
  ],
};

/** Intercept auth + chat endpoints with fixtures, then open the app. */
async function openChatWithFixtures(
  page: import("@playwright/test").Page,
  answerFixture: string,
  transcriptFixture: Record<string, unknown> = TRANSCRIPT_FIXTURE,
): Promise<void> {
  await page.route("**/v1/auth/anonymous", (route) => route.fulfill({ json: SESSION }));
  await page.route("**/v1/chat/sessions/*/messages", (route) =>
    route.fulfill({ json: transcriptFixture }),
  );
  await page.route("**/v1/chat", async (route) => {
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
  "I see the router intent, sub-queries, retrieval scores, and model identity",
  async ({ page }) => {
    const tech = page.getByTestId("trace-technical");
    await expect(tech).toBeVisible();
    await expect(tech.getByTestId("trace-intent")).toContainText("dalil_umum");
    await expect(tech.getByTestId("trace-subqueries")).toContainText("ayat kursi");
    // Scores format through Intl (0.03125 → "0,0313" in the id locale,
    // "0.0313" in en) — assert the rounded digits, not the separator.
    await expect(tech.getByTestId("trace-score").first()).toContainText(/0[.,]0313/);
    await expect(tech.getByTestId("trace-models")).toContainText("router-stub");
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
