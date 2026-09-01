#!/usr/bin/env bun
// `gh-as <role> <gh args...>` — run gh as a role's dedicated GitHub identity.
//
// Reads the role's token from the token file configured in
// scripts/role-gh-identity/config.json (never committed; outside the repo),
// exports it as GH_TOKEN for exactly this invocation, and execs gh.
// Parallel roles therefore never race a shared `gh auth switch`, and the
// manager session (no role) keeps using the owner's default identity.
//
// Also the deny-redirect target of the role-gh-identity PreToolUse hook.
//
// Token file format: the token on the first line, trailing whitespace
// stripped. No fallback to any ambient credential — a missing/unreadable
// token fails loudly (exit 1) rather than silently posting as the owner.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

const CONFIG_PATH =
  process.env.ZCODE_ROLE_IDENTITY_CONFIG ||
  join(process.env.ZCODE_PROJECT_DIR || process.cwd(), "scripts", "role-gh-identity", "config.json");

function fail(message) {
  process.stderr.write(`gh-as: ${message}\n`);
  process.exit(1);
}

const [role, ...ghArgs] = process.argv.slice(2);
if (!role) fail("usage: gh-as <role> <gh args...> — e.g. gh-as reviewer pr view 123");

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  fail(`cannot read config (${CONFIG_PATH}): ${e.message}`);
}
const entry = config.roles?.[role];
if (!entry) fail(`no identity configured for role "${role}" in ${CONFIG_PATH}`);

let token;
try {
  token = readFileSync(expandHome(entry.tokenFile), "utf8").trim();
} catch (e) {
  fail(`cannot read token file for role "${role}" (${entry.tokenFile}): ${e.message}`);
}
if (!token) fail(`token file for role "${role}" is empty (${entry.tokenFile})`);

if (ghArgs[0] === "auth" && ghArgs[1] === "status") {
  // Convenience: report which account this role maps to, from the optional
  // identities file — without ever printing the token.
  let identityHint = "(identities file not configured)";
  if (config.identitiesFile) {
    try {
      const identities = JSON.parse(readFileSync(expandHome(config.identitiesFile), "utf8"));
      identityHint = identities[role] ?? `(no entry for "${role}")`;
    } catch (e) {
      identityHint = `(cannot read identities file: ${e.message})`;
    }
  }
  process.stdout.write(`gh-as: role "${role}" → GitHub account ${identityHint}\n`);
}

const result = spawnSync("gh", ghArgs, {
  env: { ...process.env, GH_TOKEN: token },
  stdio: "inherit",
});
process.exit(result.status ?? 1);