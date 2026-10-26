import { createBdd } from "playwright-bdd";
import { expect } from "@playwright/test";

const { When, Then } = createBdd();

When("I open the FAQ page", async ({ page }) => {
  await page.goto("/faq");
});

Then("I see the FAQ heading", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /Pertanyaan, dijawab lugas|Questions, answered plainly/,
  );
});

Then("the FAQ lists its questions as disclosures", async ({ page }) => {
  await expect(page.locator("details")).toHaveCount(9);
});

When("I open the privacy page", async ({ page }) => {
  await page.goto("/privacy");
});

Then("I see the privacy heading", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Tanpa akun|No accounts/);
});

Then("I see the controller card", async ({ page }) => {
  await expect(page.getByTestId("privacy-notice-controller")).toContainText("Angga");
});

Then("I see the sub-processor register", async ({ page }) => {
  await expect(page.getByTestId("privacy-notice-processor").first()).toBeVisible();
});

When("I open the terms page", async ({ page }) => {
  await page.goto("/terms");
});

Then("I see the terms heading", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /Pendamping membaca|reading companion/,
  );
});

Then("the terms name the public contact channel", async ({ page }) => {
  await expect(page.getByText("@ahaqqu").first()).toBeVisible();
});

Then("the footer links the privacy notice and the terms", async ({ page }) => {
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: /Privasi|Privacy/ })).toBeVisible();
  await expect(footer.getByRole("link", { name: /Ketentuan|Terms/ })).toBeVisible();
});

Then("the footer opt-out link targets the privacy anchor", async ({ page }) => {
  const footer = page.getByRole("contentinfo");
  await expect(
    footer.getByRole("link", { name: /Jangan Jual atau Bagikan|Do Not Sell or Share/ }),
  ).toHaveAttribute("href", "/privacy#do-not-sell");
});

When("I open the home page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
});

Then("the header shows the full wordmark", async ({ page }) => {
  const wordmark = page.locator("header").getByText("KajianQ", { exact: true });
  await expect(wordmark).toBeVisible();
  // A truncated wordmark is the reported mobile defect: the block must be wide
  // enough to render the product name, not the two characters a clipped box
  // shows.
  const box = await wordmark.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(60);
});

Then("the header shows three round controls", async ({ page }) => {
  const header = page.locator("header");
  await expect(header.getByTestId("locale-toggle")).toBeVisible();
  await expect(header.getByTestId("theme-toggle")).toBeVisible();
  await expect(header.getByTestId("nav-menu-toggle")).toBeVisible();
});

When("I open the navigation drawer", async ({ page }) => {
  await page.getByTestId("nav-menu-toggle").click();
});

Then("I see four navigation links", async ({ page }) => {
  const drawer = page.getByTestId("nav-menu");
  await expect(drawer.getByRole("link")).toHaveCount(4);
});

Then("I see the new conversation action", async ({ page }) => {
  await expect(page.getByTestId("drawer-new-session")).toBeVisible();
});
