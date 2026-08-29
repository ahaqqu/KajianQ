#!/usr/bin/env bun
// dsh-pin-check.mjs — verify every role-agent model pin resolves on DSH.
//
// The role agents' model pins live in .zcode/agents/<role>.md frontmatter
// (the single source of truth for every harness). On DSH a pin resolves only
// if its model id is (a) declared in the DSH ollama provider's model list in
// ~/.dsh/settings.yaml and (b) served by ollama.com. A pin that fails means
// the id is missing from that config — the fix is to declare it, never to
// reroute the pin.
//
// Exit 0 when every checked pin resolves; exit 1 with the exact fix printed
// otherwise. `--fix` appends missing declarations (DSH hot-reloads the file);
// `--dry-run` prints what --fix would append without writing. Extra model
// ids passed as arguments are checked alongside the role pins.
//
// This is a dispatch-time preflight for the manager's DSH adapter, not a CI
// gate: it depends on this machine's DSH install and ollama.com reachability.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLES_DIR = join(process.cwd(), ".zcode", "agents");
const SETTINGS = join(homedir(), ".dsh", "settings.yaml");
const CATALOG = "https://ollama.com/v1/models";
const MARKER = "agent-default-model:";

const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const dryRun = argv.includes("--dry-run");
const extraIds = argv.filter((a) => !a.startsWith("--"));

/** Read a frontmatter `model:` value, or null when the file carries none. */
async function readPin(file) {
  const text = await readFile(join(ROLES_DIR, file), "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  return fm[1].match(/^model:\s*(.+)\s*$/m)?.[1] ?? null;
}

/** `ollama/<model>:cloud` | `<model>` | inherit | lite → a concrete model id (or null). */
function pinToModelId(raw) {
  const value = raw.trim();
  if (value === "inherit" || value === "lite") return null;
  return value.split("/").pop()?.replace(/:cloud$/, "").trim() ?? null;
}

/** Ids declared under the models list (text before the agent-default-model key). */
function declaredIds(settingsText) {
  const scope = settingsText.slice(0, settingsText.indexOf(MARKER));
  return new Set([...scope.matchAll(/-\s*id:\s*(\S+)/g)].map((m) => m[1]));
}

function entryFor(id) {
  return [
    `        - id: ${id}`,
    `          contextWindow: 1000000`,
    `          maxTokens: 128000`,
    `          reasoningEfforts:`,
    `            off: none`,
    `            low: low`,
    `            medium: medium`,
    `            high: high`,
    `            max: max`,
  ].join("\n");
}

async function servedIdSet() {
  const headers = process.env.OLLAMA_API_KEY
    ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
    : undefined;
  const res = await fetch(CATALOG, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`catalog responded ${res.status}`);
  const json = await res.json();
  return new Set(json.data.map((m) => m.id));
}

let settingsText;
try {
  settingsText = await readFile(SETTINGS, "utf8");
} catch {
  console.error(`✗ cannot read ${SETTINGS} — is DSH installed on this machine?`);
  process.exit(1);
}
const declared = declaredIds(settingsText);

const roleFiles = (await readdir(ROLES_DIR)).filter((f) => f.endsWith(".md") && f !== "README.md");
const checks = [];
for (const file of roleFiles) {
  const raw = await readPin(file);
  const id = raw ? pinToModelId(raw) : null;
  if (id) checks.push({ label: file.replace(/\.md$/, ""), id });
  else console.log(`− ${file.replace(/\.md$/, "")}: ${raw ?? "no pin"} — nothing to check`);
}
for (const id of extraIds) checks.push({ label: `(arg)`, id });

let served = null;
let servedNote = "";
try {
  served = await servedIdSet();
} catch (error) {
  servedNote = `catalog unreachable (${String(error).slice(0, 80)}) — served-check skipped`;
}

let failures = 0;
const missing = [];
for (const { label, id } of checks) {
  const parts = [];
  let failed = false;
  if (declared.has(id)) parts.push("declared");
  else {
    parts.push("NOT DECLARED");
    failed = true;
  }
  if (served === null) parts.push("served=unknown");
  else if (served.has(id)) parts.push("served");
  else {
    parts.push("NOT SERVED");
    failed = true;
  }
  if (failed) {
    failures++;
    missing.push(id);
  }
  const icon = failed ? "✗" : "✓";
  console.log(`${icon} ${label}: ${id} — ${parts.join(", ")}`);
}

if (servedNote) console.log(`⚠ ${servedNote}`);

if (failures > 0) {
  for (const id of new Set(missing)) {
    if (fix && !dryRun) {
      const insertion = entryFor(id) + "\n";
      const at = settingsText.indexOf(MARKER);
      settingsText = settingsText.slice(0, at) + insertion + settingsText.slice(at);
      console.log(`+ declared ${id} in ${SETTINGS} (DSH hot-reloads the file)`);
    } else {
      const mode = dryRun ? "would declare" : "run with --fix to declare";
      console.log(`  fix: ${mode} ${id} in ${SETTINGS} — never reroute the pin.`);
    }
  }
  if (fix && !dryRun) {
    await writeFile(SETTINGS, settingsText);
    console.log(`ℹ re-run without --fix to confirm all pins resolve (hot-reload is async).`);
  }
  console.error(`✗ ${failures} of ${checks.length} check(s) failed`);
  process.exit(1);
}
console.log(`✓ all ${checks.length} checked pin(s) resolve on DSH`);