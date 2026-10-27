import { readFile } from "node:fs/promises";
import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

const { When, Then } = createBdd();

/** The one conversation the seeded list holds, and what its transcript serves. */
const ENTRY = {
  id: "sess-history-1",
  title: "Apa itu ayat kursi?",
  locale: "id",
  startedAt: Date.now() - 60 * 60 * 1000,
};

const TRANSCRIPT = {
  sessionId: ENTRY.id,
  truncated: false,
  messages: [
    { id: "h1", role: "user", content: "Apa itu ayat kursi?", createdAt: 1 },
    {
      id: "h2",
      role: "assistant",
      content: "Ayat al-Kursi adalah ayat 255 surah al-Baqarah.",
      createdAt: 2,
    },
  ],
};

/**
 * Boots the chat with the token and — when `entries` is given — a seeded
 * history list, before the app's modules run. The transcript route is the only
 * stub: the drawer rehydrates through it when a conversation is opened.
 */
async function openChatWithHistory(
  page: import("@playwright/test").Page,
  entries: unknown[],
  status = 200,
): Promise<void> {
  await page.addInitScript((seed) => {
    localStorage.setItem("kajianq.consent", "store");
    localStorage.setItem("kajianq.auth.token", "tok-e2e");
    localStorage.setItem("kajianq.chat.history", JSON.stringify(seed));
  }, entries);
  await page.route("**/v1/chat/sessions/*/messages", (route) =>
    status === 200
      ? route.fulfill({ json: TRANSCRIPT })
      : route.fulfill({ status, json: { error: "invalid_request" } }),
  );
  await page.goto("/");
}

When("I open the chat with an empty history list", async ({ page }) => {
  await openChatWithHistory(page, []);
});

When("I open the chat with one stored conversation", async ({ page }) => {
  await openChatWithHistory(page, [ENTRY]);
});

When("I open the chat with one stored conversation the server has forgotten", async ({ page }) => {
  await openChatWithHistory(page, [ENTRY], 404);
});

When("I open the conversation history", async ({ page }) => {
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-drawer")).toBeVisible();
});

Then("the history drawer says there are no conversations yet", async ({ page }) => {
  await expect(page.getByTestId("history-empty")).toContainText("Belum ada percakapan");
});

When("I press Escape", async ({ page }) => {
  await page.keyboard.press("Escape");
});

Then("the history drawer is closed", async ({ page }) => {
  await expect(page.getByTestId("history-drawer")).toHaveCount(0);
});

Then("the drawer lists that conversation", async ({ page }) => {
  await expect(page.getByTestId("history-entry")).toHaveCount(1);
  await expect(page.getByTestId("history-entry")).toContainText(ENTRY.title);
  await expect(page.getByTestId("history-entry")).toContainText("jam lalu");
});

When("I reopen that conversation", async ({ page }) => {
  await page.getByTestId("history-entry").getByRole("button").first().click();
});

Then("the drawer closes and the transcript shows its first question", async ({ page }) => {
  await expect(page.getByTestId("history-drawer")).toHaveCount(0);
  await expect(page.getByTestId("message-list")).toContainText("Apa itu ayat kursi?");
});

Then("the row is marked expired and stays in the list", async ({ page }) => {
  await expect(page.getByTestId("history-notice")).toContainText("sudah tidak tersedia");
  await expect(page.getByTestId("history-entry")).toHaveAttribute("data-expired", "true");
  await expect(page.getByTestId("history-entry")).toContainText("Kedaluwarsa");
  await expect(page.getByTestId("history-drawer")).toBeVisible();
});

When("I remove it", async ({ page }) => {
  await page
    .getByTestId("history-entry")
    .getByRole("button", { name: "Hapus dari daftar" })
    .click();
});

Then("the list is empty", async ({ page }) => {
  await expect(page.getByTestId("history-empty")).toBeVisible();
});

Then("downloading that conversation writes a Markdown file", async ({ page }) => {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("history-download").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(
    /^kajianq-apa-itu-ayat-kursi-\d{4}-\d{2}-\d{2}\.md$/,
  );
  const path = await download.path();
  expect(path).not.toBeNull();
  const content = await readFile(path!, "utf8");
  expect(content).toContain("# Apa itu ayat kursi?");
  expect(content).toContain("## Anda");
  expect(content).toContain("## KajianQ");
});
