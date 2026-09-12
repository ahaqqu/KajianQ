import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Chat UI BDD (#11). All /v1/* traffic is intercepted with fixture streams —
 * zero LLM spend in CI (plan decision 4); the live path stays covered by
 * eval:smoke in the Staging workflow. The fixtures mirror the wire contract
 * (ADR-0034 + ADR-0040): meta → delta(s) → citations → done.
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
  "event: done\ndata: {}\n\n",
].join("");

const DHAIF_WARNING =
  "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";

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

When("I ask something the corpus cannot answer", async ({ page }) => {
  await openChatWithFixtures(page, REFUSAL_FIXTURE);
  await page.getByTestId("composer").fill("Pertanyaan di luar cakupan?");
  await page.getByTestId("send").click();
});

When("I open a chat whose stored transcript was capped", async ({ page }) => {
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
