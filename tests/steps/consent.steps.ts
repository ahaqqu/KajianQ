import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

const { When, Then } = createBdd();

/** The keys this feature is about: chat state and the consent record itself. */
const CHAT_KEYS = [
  "kajianq.consent",
  "kajianq.auth.token",
  "kajianq.chat.sessionId",
  "kajianq.chat.history",
];

When("I open the chat in a fresh browser", async ({ page }) => {
  await page.goto("/");
});

Then("the consent card asks before anything is kept", async ({ page }) => {
  await expect(page.getByTestId("consent-card")).toContainText("SEBELUM MULAI");
  await expect(page.getByTestId("consent-card")).toContainText("jika Anda setuju");
});

Then("no chat data is stored in the browser", async ({ page }) => {
  const stored = await page.evaluate(() => Object.keys(localStorage));
  expect(stored.filter((key) => CHAT_KEYS.includes(key))).toEqual([]);
});

When("I choose not to keep anything", async ({ page }) => {
  await page.getByTestId("consent-decline").click();
});

When("I choose to keep the conversation", async ({ page }) => {
  await page.getByTestId("consent-keep").click();
});

/**
 * One answer's worth of wire traffic, so the grant path is exercised end to end:
 * the anonymous token mint, then the stream. The other chat features carry the
 * rich fixtures; this one only needs the turn to complete.
 */
const ONE_ANSWER = [
  'event: meta\ndata: {"sessionId":"sess-consent","messageId":"m-consent","traceId":"tr-consent"}\n\n',
  "event: delta\ndata: Ayat al-Kursi adalah ayat 255 surah al-Baqarah.\n\n",
  'event: citations\ndata: {"messageId":"m-consent","refusal":false,"dhaifWarning":false,"citations":[]}\n\n',
  "event: done\ndata: {}\n\n",
].join("");

When("I ask about ayat kursi on that page", async ({ page }) => {
  await page.route("**/v1/auth/anonymous", (route) =>
    route.fulfill({
      json: { userId: "u1", sessionId: "sess-consent", token: "tok-consent", expiresAt: 1 },
    }),
  );
  await page.route("**/v1/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ONE_ANSWER,
    }),
  );
  await page.getByTestId("composer").fill("Apa itu ayat kursi?");
  await page.getByTestId("send").click();
  await expect(page.getByText("Ayat al-Kursi adalah ayat 255 surah al-Baqarah.")).toBeVisible();
});

Then("the browser keeps the session for next time", async ({ page }) => {
  const kept = await page.evaluate(() => ({
    token: localStorage.getItem("kajianq.auth.token"),
    session: localStorage.getItem("kajianq.chat.sessionId"),
  }));
  expect(kept.token).not.toBeNull();
  expect(kept.session).not.toBeNull();
});

Then("the consent card is gone", async ({ page }) => {
  await expect(page.getByTestId("consent-card")).toHaveCount(0);
});

Then("only the choice is stored", async ({ page }) => {
  const stored = await page.evaluate(() => Object.keys(localStorage));
  expect(stored.filter((key) => CHAT_KEYS.includes(key))).toEqual(["kajianq.consent"]);
  const choice = await page.evaluate(() => localStorage.getItem("kajianq.consent"));
  expect(choice).toBe("session-only");
});

Then("reloading does not ask again", async ({ page }) => {
  await page.reload();
  await expect(page.getByTestId("consent-card")).toHaveCount(0);
});

Then("the drawer offers to stop keeping conversations", async ({ page }) => {
  await expect(page.getByTestId("consent-disable")).toContainText("Berhenti menyimpan");
});

When("I stop keeping conversations", async ({ page }) => {
  await page.getByTestId("consent-disable").click();
});

Then("the drawer says browser storage is off", async ({ page }) => {
  await expect(page.getByTestId("history-consent-off")).toContainText(
    "Penyimpanan di peramban mati",
  );
  await expect(page.getByTestId("consent-enable")).toBeVisible();
});

Then("the storage line names the consent choice and when it applies", async ({ page }) => {
  const card = page.getByTestId("privacy-notice-storage");
  await expect(card).toContainText("Setelah Anda setuju");
  await expect(card).toContainText("kajianq.consent");
});
