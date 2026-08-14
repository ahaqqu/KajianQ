#!/usr/bin/env bun
/**
 * One-time provisioning: create Cloudflare D1 databases and R2 buckets,
 * then print the D1 UUIDs as copy-pasteable `gh secret set` commands.
 *
 * Reads database/bucket names from apps/api/wrangler.toml so it works for
 * any fork. Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env
 * vars (set as GitHub secrets).
 *
 * The default GITHUB_TOKEN in Actions cannot write repository secrets, so
 * after the first run you set D1_DATABASE_ID and D1_DATABASE_ID_STAGING
 * once — the script prints the exact commands. Locally (with `gh auth
 * login`), it sets them automatically.
 *
 * Usage (local):
 *   bun scripts/provision-cf.mjs
 *
 * Idempotent: if a database or bucket already exists, it reuses it and
 * prints the existing UUID. Safe to re-run.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const CONFIG_PATH = `${ROOT}/apps/api/wrangler.toml`;

// Minimal TOML parser for the fields we need. wrangler.toml is simple
// enough that a regex-based parse is reliable and avoids adding a TOML
// dependency.
function parseWranglerToml(path) {
  const text = readFileSync(path, "utf8");

  // Production d1: first [[d1_databases]] block (before [env.staging])
  const prodSection = text.split("[env.staging]")[0] ?? "";
  const prodD1Match = prodSection.match(
    /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/,
  );
  const prodR2Match = prodSection.match(
    /\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/,
  );

  // Staging d1: [[env.staging.d1_databases]] block
  const stagingSection = text.split("[env.staging]")[1] ?? "";
  const stagingD1Match = stagingSection.match(
    /\[\[env\.staging\.d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/,
  );
  const stagingR2Match = stagingSection.match(
    /\[\[env\.staging\.r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/,
  );

  if (!prodD1Match) throw new Error("Could not parse production database_name from wrangler.toml");
  if (!stagingD1Match) throw new Error("Could not parse staging database_name from wrangler.toml");

  return {
    prodD1Name: prodD1Match[1],
    prodR2Name: prodR2Match?.[1] ?? null,
    stagingD1Name: stagingD1Match[1],
    stagingR2Name: stagingR2Match?.[1] ?? null,
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
 * Create a D1 database, or return the existing UUID if it already exists.
 * `wrangler d1 create` is not idempotent — it errors if the DB exists.
 */
function ensureD1(name) {
  // Try to list existing databases and find this name.
  const listOut = run("bunx wrangler d1 list --json", { ignoreError: true });
  if (listOut) {
    try {
      const dbs = JSON.parse(listOut);
      const existing = dbs.find((db) => db.name === name);
      if (existing) {
        console.log(`D1 "${name}" already exists (uuid: ${existing.uuid}) — reusing.`);
        return existing.uuid;
      }
    } catch {
      // --json not supported or unexpected output; fall through to create
    }
  }
  // Create it.
  const out = run(`bunx wrangler d1 create "${name}"`);
  console.log(`D1 "${name}" created.`);
  // Output contains: database_id = "uuid" or a UUID in the text.
  const uuidMatch = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!uuidMatch) throw new Error(`Could not extract UUID from wrangler d1 create output:\n${out}`);
  return uuidMatch[1];
}

/**
 * Create an R2 bucket, or do nothing if it already exists.
 * `wrangler r2 bucket create` errors with code 10004 if the bucket exists.
 * `wrangler r2 bucket list` doesn't support --json reliably, so we catch
 * the "already exists" error instead of pre-checking.
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

/**
 * Try to set a GitHub secret via `gh`. In CI, the default GITHUB_TOKEN
 * lacks admin scope so this will fail — the caller prints fallback
 * instructions. Locally (with `gh auth login`), this works.
 */
function trySetGitHubSecret(name, value) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return false;
  }
  const result = run(`echo "${value}" | gh secret set "${name}"`, {
    ignoreError: true,
  });
  if (result === null) return false;
  console.log(`GitHub secret "${name}" set.`);
  return true;
}

function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set.");

  const { prodD1Name, prodR2Name, stagingD1Name, stagingR2Name } =
    parseWranglerToml(CONFIG_PATH);

  console.log(`Provisioning Cloudflare resources from wrangler.toml:`);
  console.log(`  Production D1: ${prodD1Name}`);
  console.log(`  Staging D1:    ${stagingD1Name}`);
  if (prodR2Name) console.log(`  Production R2: ${prodR2Name}`);
  if (stagingR2Name) console.log(`  Staging R2:    ${stagingR2Name}`);
  console.log("");

  // D1 databases
  const prodUuid = ensureD1(prodD1Name);
  const stagingUuid = ensureD1(stagingD1Name);

  // R2 buckets
  ensureR2(prodR2Name);
  ensureR2(stagingR2Name);

  // Try to set GitHub secrets (works locally with gh auth; fails in CI)
  console.log("");
  const prodSecretSet = trySetGitHubSecret("D1_DATABASE_ID", prodUuid);
  const stagingSecretSet = trySetGitHubSecret("D1_DATABASE_ID_STAGING", stagingUuid);

  console.log("");
  console.log("Provisioning complete.");
  console.log(`  D1_DATABASE_ID          = ${prodUuid}`);
  console.log(`  D1_DATABASE_ID_STAGING  = ${stagingUuid}`);
  console.log("");

  if (!prodSecretSet || !stagingSecretSet) {
    console.log("⚠️  GitHub secrets could not be auto-set.");
    console.log("    The default GITHUB_TOKEN in Actions cannot write secrets.");
    console.log("    Run one of these commands from a terminal with gh auth login:");
    console.log("");
    console.log(`      echo "${prodUuid}" | gh secret set D1_DATABASE_ID --repo <owner/repo>`);
    console.log(`      echo "${stagingUuid}" | gh secret set D1_DATABASE_ID_STAGING --repo <owner/repo>`);
    console.log("");
    console.log("    Or set them in the browser:");
    console.log("    Settings → Secrets and variables → Actions → New repository secret");
    console.log(`      D1_DATABASE_ID          = ${prodUuid}`);
    console.log(`      D1_DATABASE_ID_STAGING  = ${stagingUuid}`);
    console.log("");
    console.log("    After setting the secrets, run the Staging or Deploy production");
    console.log("    workflow to deploy.");
  } else {
    console.log("All secrets set automatically. Next: run the Staging or Deploy");
    console.log("production workflow to deploy.");
  }
}

main();