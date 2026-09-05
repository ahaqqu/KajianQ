import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireFiles } from "../../packages/kajianq-domain/scripts/source-acquisition.mjs";

/**
 * Regression tests for the ingest-script acquisition layer (PR #108 review
 * A5/A7): the old single-arg URL-based `resolve` silently dropped path
 * segments — `resolve(cacheDir, cacheFile)` read the cache DIR itself
 * (EISDIR, rethrown by the not-ENOENT guard), and `--limit abc/0` either
 * ingested nothing with a success report or ran the full corpus via
 * falsiness.
 */

const INGEST_HADITH = resolve(process.cwd(), "packages/kajianq-domain/scripts/ingest-hadith.mjs");

const QUIET_LOG = { info: () => {}, warn: () => {}, error: () => {} };

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-acquire-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("acquireFiles cache-dir mode (review A5)", () => {
  it("reads `cacheDir/cacheFile`, not the cache dir itself", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "ara-bukhari.json"), "{\"ok\":true}");
      const texts = await acquireFiles(
        [{ url: "https://example.invalid/ara-bukhari.json", cacheFile: "ara-bukhari.json" }],
        { log: QUIET_LOG, cacheDir: dir },
      );
      expect(texts).toEqual(["{\"ok\":true}"]);
    });
  });

  it("falls through to the network only when the cache file is absent", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "present.json"), "from-cache");
      const originalFetch = globalThis.fetch;
      let fetched = 0;
      globalThis.fetch = async () => {
        fetched += 1;
        return { ok: true, text: async () => "from-network" };
      };
      try {
        const texts = await acquireFiles(
          [
            { url: "https://example.invalid/a.json", cacheFile: "missing.json" },
            { url: "https://example.invalid/b.json", cacheFile: "present.json" },
          ],
          { log: QUIET_LOG, cacheDir: dir },
        );
        expect(fetched).toBe(1);
        expect(texts).toEqual(["from-network", "from-cache"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("fails loudly on a misconfigured cache path (EISDIR), never silently refetches", async () => {
    await withTempDir(async (dir) => {
      // `present.json` exists as a DIRECTORY — reading it is EISDIR, which
      // the guard must rethrow (only ENOENT falls through to fetch).
      mkdirSync(join(dir, "present.json"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("must not refetch on non-ENOENT cache errors");
      };
      try {
        await expect(
          acquireFiles([{ url: "https://example.invalid/a.json", cacheFile: "present.json" }], {
            log: QUIET_LOG,
            cacheDir: dir,
          }),
        ).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("ingest:hadith --limit validation (review A7)", () => {
  // The CLI is a Bun script (workspace @app imports resolve via Bun); the
  // bun executable comes from PATH, same as CI's setup-bun step.
  const BUN = process.env.BUN_BINARY ?? "bun";

  function runLimit(value) {
    return spawnSync(BUN, [INGEST_HADITH, "--limit", value], {
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("rejects a non-integer limit with a clear message", () => {
    const r = runLimit("abc");
    expect(r.status).toBe(1);
    expect(`${r.stderr}${r.stdout}`).toContain("--limit must be an integer >= 1");
  });

  it("rejects --limit 0 (falsiness must not mean full corpus)", () => {
    const r = runLimit("0");
    expect(r.status).toBe(1);
    expect(`${r.stderr}${r.stdout}`).toContain("--limit must be an integer >= 1");
  });
});
