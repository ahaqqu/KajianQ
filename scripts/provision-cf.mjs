#!/usr/bin/env bun
/**
 * One-time provisioning: create Cloudflare R2 buckets and derive deploy URLs,
 * then print copy-pasteable `gh variable set` commands for the deploy pipeline.
 *
 * Persistence is Neon Postgres behind the RagStore seam (ADR-0008) — there is
 * no D1 to create. Neon itself is provisioned by #4, outside this script.
 *
 * Reads bucket/worker names from apps/api/wrangler.toml. Requires
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars (set as GitHub
 * secrets). The default GITHUB_TOKEN cannot write repository variables, so
 * after the first run you set PROD_URL / STAGING_URL once — the script prints
 * the exact commands. Locally (with `gh auth login`), it sets them itself.
 *
 * Usage (local):
 *   bun scripts/provision-cf.mjs
 *
 * Idempotent: an existing bucket is reused. Safe to re-run.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const CONFIG_PATH = `${ROOT}/apps/api/wrangler.toml`;

// Minimal TOML parser for the fields we need. wrangler.toml is simple enough
// that a regex-based parse is reliable and avoids adding a TOML dependency.
function parseWranglerToml(path) {
  const text = readFileSync(path, "utf8");

  const prodSection = text.split("[env.staging]")[0] ?? "";
  const prodR2Match = prodSection.match(
    /\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/,
  );

  const stagingSection = text.split("[env.staging]")[1] ?? "";
  const stagingR2Match = stagingSection.match(
    /\[\[env\.staging\.r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/,
  );

  const prodWorkerMatch = prodSection.match(/^name\s*=\s*"([^"]+)"/m);
  const stagingWorkerMatch = stagingSection.match(/^name\s*=\s*"([^"]+)"/m);
  if (!prodWorkerMatch)
    throw new Error("Could not parse production worker name from wrangler.toml");
  if (!stagingWorkerMatch)
    throw new Error("Could not parse staging worker name from wrangler.toml");

  return {
    prodR2Name: prodR2Match?.[1] ?? null,
    stagingR2Name: stagingR2Match?.[1] ?? null,
    prodWorkerName: prodWorkerMatch[1],
    stagingWorkerName: stagingWorkerMatch[1],
  };
}

function run(cmd, { ignoreError = false } = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (ignoreError) return null;
    throw err;
  }
}

/**
 * Create an R2 bucket, or do nothing if it already exists.
 * `wrangler r2 bucket create` errors with code 10004 if the bucket exists.
 */
function ensureR2(name) {
  if (!name) return;
  try {
    run(`bunx wrangler r2 bucket create "${name}"`);
    console.log(`R2 "${name}" created.`);
  } catch (err) {
    const stderr = err.stderr?.toString() ?? err.message ?? "";
    if (stderr.includes("already exists") || stderr.includes("10004")) {
      console.log(`R2 "${name}" already exists — reusing.`);
    } else {
      throw err;
    }
  }
}

/** Set a GitHub variable via `gh` (works locally; fails with default Actions token). */
function trySetGitHubVariable(name, value) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return false;
  const result = run(`echo "${value}" | gh variable set "${name}"`, {
    ignoreError: true,
  });
  if (result === null) return false;
  console.log(`GitHub variable "${name}" set.`);
  return true;
}

/** Fetch the workers.dev subdomain so URLs are https://<worker>.<sub>.workers.dev */
function fetchWorkersDevSubdomain(accountId, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const out = run(`curl -sf -H "Authorization: Bearer ${token}" "${url}"`, {
    ignoreError: true,
  });
  if (!out) return null;
  try {
    return JSON.parse(out)?.result?.subdomain ?? null;
  } catch {
    return null;
  }
}

function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set.");

  const { prodR2Name, stagingR2Name, prodWorkerName, stagingWorkerName } =
    parseWranglerToml(CONFIG_PATH);

  console.log("Provisioning Cloudflare resources from wrangler.toml:");
  if (prodR2Name) console.log(`  Production R2: ${prodR2Name}`);
  if (stagingR2Name) console.log(`  Staging R2:    ${stagingR2Name}`);
  console.log(`  Production worker: ${prodWorkerName}`);
  console.log(`  Staging worker:    ${stagingWorkerName}`);
  console.log("");

  ensureR2(prodR2Name);
  ensureR2(stagingR2Name);

  // Derive deploy URLs from worker names + workers.dev subdomain.
  const subdomain = fetchWorkersDevSubdomain(accountId, token);
  let prodUrl = null;
  let stagingUrl = null;
  if (subdomain) {
    prodUrl = `https://${prodWorkerName}.${subdomain}.workers.dev`;
    stagingUrl = `https://${stagingWorkerName}.${subdomain}.workers.dev`;
    console.log(`  workers.dev subdomain: ${subdomain}`);
    console.log(`  PROD_URL:    ${prodUrl}`);
    console.log(`  STAGING_URL: ${stagingUrl}`);
  } else {
    console.log("  ⚠️  Could not fetch workers.dev subdomain from Cloudflare API.");
    console.log("     PROD_URL and STAGING_URL will need to be set manually.");
  }
  console.log("");

  const prodVarSet = prodUrl ? trySetGitHubVariable("PROD_URL", prodUrl) : false;
  const stagingVarSet = stagingUrl
    ? trySetGitHubVariable("STAGING_URL", stagingUrl)
    : false;

  console.log("Provisioning complete.");
  if (prodUrl) console.log(`  PROD_URL                = ${prodUrl}`);
  if (stagingUrl) console.log(`  STAGING_URL             = ${stagingUrl}`);
  console.log("");

  const needManual = (prodUrl && !prodVarSet) || (stagingUrl && !stagingVarSet);
  if (needManual) {
    console.log("⚠️  Some GitHub variables could not be auto-set.");
    console.log("    Run these commands from a terminal with gh auth login:");
    console.log("");
    if (prodUrl && !prodVarSet)
      console.log(`      echo "${prodUrl}" | gh variable set PROD_URL --repo <owner/repo>`);
    if (stagingUrl && !stagingVarSet)
      console.log(`      echo "${stagingUrl}" | gh variable set STAGING_URL --repo <owner/repo>`);
    console.log("");
  } else {
    console.log("All variables set. Next: push to main (or run the Staging");
    console.log("workflow) to deploy staging; run Deploy production for prod.");
  }
}

main();
