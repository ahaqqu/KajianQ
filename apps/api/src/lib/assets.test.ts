import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiskAssetFetcher } from "./assets";

/**
 * The disk-backed ASSETS fetcher (#181, ADR-0044). This is what makes the SPA
 * servable from the Bun host, so its two policies are pinned: a real file is
 * served with its content type, and any other path falls back to `index.html`
 * (the app is a client-side router — a deep link must reach the shell). Path
 * traversal must not escape the web root.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kajianq-assets-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>shell</title>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log('app')");
  // A file OUTSIDE the root, to prove traversal cannot reach it.
  writeFileSync(join(root, "..", "kajianq-assets-secret.txt"), "secret");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(root, "..", "kajianq-assets-secret.txt"), { force: true });
});

describe("createDiskAssetFetcher", () => {
  it("serves an existing file with a content type by extension", async () => {
    const assets = createDiskAssetFetcher(root);
    const res = await assets.fetch(new Request("https://x/assets/app-abc123.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log('app')");
  });

  it("falls back to index.html for a client-side route", async () => {
    const assets = createDiskAssetFetcher(root);
    const res = await assets.fetch(new Request("https://x/chat/some/deep/link"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("shell");
  });

  it("serves index.html at the root path", async () => {
    const assets = createDiskAssetFetcher(root);
    const res = await assets.fetch(new Request("https://x/"));
    expect(await res.text()).toContain("shell");
  });

  it("does not let a traversal path escape the web root", async () => {
    const assets = createDiskAssetFetcher(root);
    // Both the encoded and raw forms must resolve inside the root, so the
    // secret sibling file is never reachable — the request falls back to the
    // SPA shell instead.
    for (const path of ["/../kajianq-assets-secret.txt", "/%2e%2e/kajianq-assets-secret.txt"]) {
      const res = await assets.fetch(new Request(`https://x${path}`));
      expect(await res.text()).not.toContain("secret");
    }
  });

  it("answers 503 rather than a broken shell when the build is absent", async () => {
    const assets = createDiskAssetFetcher(join(root, "does-not-exist"));
    const res = await assets.fetch(new Request("https://x/chat"));
    expect(res.status).toBe(503);
  });
});
