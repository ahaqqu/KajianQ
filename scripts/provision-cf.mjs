#!/usr/bin/env bun
/**
 * Provisioning entry point kept for the template-owned provision.yml
 * (ADR-0028): cloud resources are owned by Alchemy, so this script only
 * delegates to the same bootstrap deploys an operator would run —
 * `alchemy deploy --adopt` for prod and staging, which adopts the
 * wrangler-era resources on first use and no-ops on every run after — and
 * then does the one piece Alchemy does not own: deriving the workers.dev
 * URLs and setting the PROD_URL / STAGING_URL GitHub variables that the
 * deploy workflow's smoke tests consume.
 *
 * Physical names mirror apps/api/alchemy.run.ts. Requires
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars (set as GitHub
 * secrets). The default GITHUB_TOKEN cannot write repository variables, so
 * when the variable step fails the script prints the exact `gh variable set`
 * commands instead.
 *
 * Usage:
 *   bun scripts/provision-cf.mjs        (dispatch of provision.yml, or local)
 *
 * Idempotent: safe to re-run.
 */
import { execSync } from "node:child_process";

// Physical names pinned in apps/api/alchemy.run.ts (ADR-0028). Keep in sync.
const NAMES = {
  prodWorker: "kajianq-api",
  stagingWorker: "kajianq-api-staging",
};

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runReport(cmd, label) {
  console.log(`\n== ${label}`);
  try {
    run(cmd);
    console.log("done.");
    return true;
  } catch (err) {
    console.error(String(err.stderr ?? err.stdout ?? err.message ?? err).trim());
    console.error(`FAILED: ${label}`);
    return false;
  }
}

/** Set a GitHub variable via `gh` (works locally; fails with default Actions token). */
function trySetGitHubVariable(name, value) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return false;
  try {
    run(`echo "${value}" | gh variable set "${name}"`);
    console.log(`GitHub variable "${name}" set.`);
    return true;
  } catch {
    return false;
  }
}

/** Fetch the workers.dev subdomain so URLs are https://<worker>.<sub>.workers.dev */
function fetchWorkersDevSubdomain(accountId, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const out = execSync(
    `curl -sf -H "Authorization: Bearer ${token}" "${url}"`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return JSON.parse(out)?.result?.subdomain ?? null;
}

function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set.");

  // Cloud provisioning is delegated to Alchemy (adopts on first run, then no-ops).
  const prodOk = runReport("bun run deploy:bootstrap", "Bootstrap prod (alchemy deploy --adopt)");
  const stagingOk = runReport(
    "bun run deploy:bootstrap:staging",
    "Bootstrap staging (alchemy deploy --adopt)",
  );

  // Derive deploy URLs from worker names + workers.dev subdomain.
  const subdomain = fetchWorkersDevSubdomain(accountId, token);
  let prodUrl = null;
  let stagingUrl = null;
  if (subdomain) {
    prodUrl = `https://${NAMES.prodWorker}.${subdomain}.workers.dev`;
    stagingUrl = `https://${NAMES.stagingWorker}.${subdomain}.workers.dev`;
    console.log(`\nworkers.dev subdomain: ${subdomain}`);
    console.log(`  PROD_URL:    ${prodUrl}`);
    console.log(`  STAGING_URL: ${stagingUrl}`);
  } else {
    console.log("\n⚠️  Could not fetch workers.dev subdomain from Cloudflare API.");
    console.log("   PROD_URL and STAGING_URL will need to be set manually.");
  }

  const prodVarSet = prodUrl ? trySetGitHubVariable("PROD_URL", prodUrl) : false;
  const stagingVarSet = stagingUrl
    ? trySetGitHubVariable("STAGING_URL", stagingUrl)
    : false;

  const needManual = (prodUrl && !prodVarSet) || (stagingUrl && !stagingVarSet);
  if (needManual) {
    console.log("\n⚠️  Some GitHub variables could not be auto-set (GITHUB_TOKEN lacks");
    console.log("    variable-write in Actions). From a terminal with gh auth login:");
    if (prodUrl && !prodVarSet)
      console.log(`      echo "${prodUrl}" | gh variable set PROD_URL --repo <owner/repo>`);
    if (stagingUrl && !stagingVarSet)
      console.log(`      echo "${stagingUrl}" | gh variable set STAGING_URL --repo <owner/repo>`);
  }

  if (!prodOk || !stagingOk) {
    console.error("\nProvisioning incomplete: one or more bootstrap deploys failed.");
    process.exit(1);
  }
  console.log("\nProvisioning complete.");
}

main();
