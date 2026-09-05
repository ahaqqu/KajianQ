#!/usr/bin/env bun
/**
 * One-time provisioning: create Cloudflare R2 buckets and derive deploy URLs,
 * then print copy-pasteable `gh variable set` commands for the deploy pipeline.
 *
 * Persistence is Neon Postgres behind the RagStore seam (ADR-0008) — there is
 * no D1 to create. Neon itself is provisioned by #4, outside this script.
 * Bucket/worker physical names mirror apps/api/alchemy.run.ts (ADR-0028),
 * which owns provisioning going forward — this script remains only because
 * the template-owned provision.yml invokes it.
 *
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars (set as
 * GitHub secrets). The default GITHUB_TOKEN cannot write repository variables,
 * so after the first run you set PROD_URL / STAGING_URL once — the script
 * prints the exact commands. Locally (with `gh auth login`), it sets them
 * itself.
 *
 * Usage (local):
 *   bun scripts/provision-cf.mjs
 *
 * Idempotent: an existing bucket is reused. Safe to re-run.
 */
import { execSync } from "node:child_process";

// Physical names pinned in apps/api/alchemy.run.ts (ADR-0028). Keep in sync.
const NAMES = {
  prodR2: "kajianq-raw",
  stagingR2: "kajianq-raw-staging",
  prodWorker: "kajianq-api",
  stagingWorker: "kajianq-api-staging",
};

function run(cmd, { ignoreError = false } = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (ignoreError) return null;
    throw err;
  }
}

/**
 * Create an R2 bucket via the Cloudflare API, or do nothing if it exists
 * (the API reports error code 10004 for a duplicate name).
 */
async function ensureR2(accountId, token, name) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`R2 "${name}" created.`);
    return;
  }
  const code = body?.errors?.[0]?.code;
  if (code === 10004 || JSON.stringify(body).includes("already exists")) {
    console.log(`R2 "${name}" already exists — reusing.`);
    return;
  }
  throw new Error(`R2 create failed for "${name}": HTTP ${res.status} ${JSON.stringify(body)}`);
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

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set.");

  console.log("Provisioning Cloudflare resources (names mirror alchemy.run.ts):");
  console.log(`  Production R2: ${NAMES.prodR2}`);
  console.log(`  Staging R2:    ${NAMES.stagingR2}`);
  console.log(`  Production worker: ${NAMES.prodWorker}`);
  console.log(`  Staging worker:    ${NAMES.stagingWorker}`);
  console.log("");

  await ensureR2(accountId, token, NAMES.prodR2);
  await ensureR2(accountId, token, NAMES.stagingR2);

  // Derive deploy URLs from worker names + workers.dev subdomain.
  const subdomain = fetchWorkersDevSubdomain(accountId, token);
  let prodUrl = null;
  let stagingUrl = null;
  if (subdomain) {
    prodUrl = `https://${NAMES.prodWorker}.${subdomain}.workers.dev`;
    stagingUrl = `https://${NAMES.stagingWorker}.${subdomain}.workers.dev`;
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
