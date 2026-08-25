#!/usr/bin/env bun
/**
 * Pre-deploy: inject the real D1 database_id into apps/api/wrangler.toml.
 *
 * wrangler does not interpolate env vars in wrangler.toml (TOML values are
 * read literally), so the real UUID — supplied via a CI secret or local env
 * var — must be substituted into the config file before `wrangler deploy`.
 *
 * The committed wrangler.toml always has the sentinel; this script mutates
 * the working copy only (CI runners are ephemeral; locally, the change is
 * unstaged and `git checkout` restores it).
 *
 * Usage:
 *   D1_DATABASE_ID=...        bun run deploy:inject          # production
 *   D1_DATABASE_ID_STAGING=... bun run deploy:inject:staging  # staging
 *
 * Exits 1 if the required env var is missing — never silently deploy with
 * the sentinel still in place.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CONFIG = join(ROOT, "apps/api/wrangler.toml");
const PROD_SENTINEL = "replace-me-with-your-d1-uuid";
const STAGING_SENTINEL = "replace-me-with-your-d1-uuid-staging";

function inject(envVar, sentinel) {
  const uuid = process.env[envVar];
  if (!uuid) {
    console.error(
      `inject-d1-id: ${envVar} is not set. Set it from your Cloudflare D1 database (wrangler d1 list) or CI secret.`,
    );
    process.exit(1);
  }
  const text = readFileSync(CONFIG, "utf8");
  if (!text.includes(sentinel)) {
    // Sentinel already replaced (e.g. re-run) — nothing to do.
    console.log(`inject-d1-id: sentinel already replaced (${sentinel})`);
    return;
  }
  writeFileSync(CONFIG, text.replaceAll(sentinel, uuid));
  console.log(`inject-d1-id: injected ${envVar} into apps/api/wrangler.toml`);
}

const mode = process.argv[2];
if (mode === "staging") {
  inject("D1_DATABASE_ID_STAGING", STAGING_SENTINEL);
} else {
  inject("D1_DATABASE_ID", PROD_SENTINEL);
}