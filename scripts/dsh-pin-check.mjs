#!/usr/bin/env bun
// dsh-pin-check.mjs — verify every role-agent model pin resolves on DSH.
//
// The role agents' model pins live in .zcode/agents/<role>.md frontmatter
// (the single source of truth for every harness). On DSH a pin resolves only
// if its model id is (a) declared in the DSH ollama provider's model list in
// ~/.dsh/settings.yaml and (b) served by ollama.com. A missing declaration
// is fixed by declaring the id — never by rerouting the pin. An id the
// catalog does not serve cannot be fixed by declaring it: that failure means
// the pin or the provider must change, and --fix refuses to write for it.
//
// Exit 0 when every checked pin resolves; exit 1 with the exact fix printed
// otherwise. `--fix` appends missing declarations to the ollama provider's
// models list — atomically (temp file + rename), after writing a timestamped
// backup beside the original (the file is a machine-global config no VCS
// can restore). `--dry-run` prints what --fix would append without writing.
// Extra model ids are checked only via an explicit `--check <id>` flag —
// bare positional arguments are rejected: this script writes to a global
// config and must not act on a mistyped flag.
//
// Pin values: `inherit` (and a missing `model:` field) resolves to the
// session model via a plain `subagent` dispatch — noted, not pin-checked.
// `lite` has no DSH mapping and fails the gate: make the pin concrete.
//
// This is a dispatch-time preflight for the manager's DSH adapter, not a CI
// gate: it depends on this machine's DSH install and ollama.com reachability.
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLES_DIR = join(import.meta.dir, "..", ".zcode", "agents");
const SETTINGS = join(homedir(), ".dsh", "settings.yaml");
const CATALOG = "https://ollama.com/v1/models";
const PROVIDER = "ollama";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const dryRun = argv.includes("--dry-run");
const extraIds = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--check") {
    const id = argv[++i];
    if (!id) fail("--check requires a model id: --check <model-id>");
    extraIds.push(id);
  } else if (!a.startsWith("--")) {
    fail(`unexpected argument "${a}" — extra ids are checked via --check <model-id>, never positionally`);
  }
}

/** Read a frontmatter `model:` value, or null when the file carries none. */
async function readPin(file) {
  let text;
  try {
    text = await readFile(join(ROLES_DIR, file), "utf8");
  } catch (error) {
    fail(`cannot read ${join(ROLES_DIR, file)} (${error.code ?? error.message})`);
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  return fm[1].match(/^model:\s*(.+)\s*$/m)?.[1] ?? null;
}

/** `ollama/<model>:cloud` | `<model>` → a concrete model id. */
function pinToModelId(raw) {
  return raw.split("/").pop()?.replace(/:cloud$/, "").trim() ?? null;
}

const indentOf = (line) => line.length - line.trimStart().length;

/** The ollama provider's `models:` list, as line indices: { modelsIdx, end,
 * modelsIndent } with `end` just past the last entry. Both the declared-id
 * scan and the --fix insertion are scoped to this block — never to "all text
 * before a marker" — so an unexpected file shape fails loudly instead of
 * splicing entries into the wrong place. */
function modelsBlock(lines) {
  const providerIdx = lines.findIndex((l) => l.trim() === `${PROVIDER}:`);
  if (providerIdx === -1)
    fail(`no "${PROVIDER}:" provider block in ${SETTINGS} — declare the provider before pinning models against it`);
  const providerEnd = lines.findIndex(
    (l, i) => i > providerIdx && l.trim() && indentOf(l) <= indentOf(lines[providerIdx]),
  );
  const endOfProvider = providerEnd === -1 ? lines.length : providerEnd;
  const modelsIdx =
    lines.slice(providerIdx + 1, endOfProvider).findIndex((l) => l.trim() === "models:") + providerIdx + 1;
  if (modelsIdx === providerIdx)
    fail(`no "models:" list under the ${PROVIDER} provider in ${SETTINGS} — refusing to guess where to declare`);
  const modelsIndent = indentOf(lines[modelsIdx]);
  let end = modelsIdx + 1;
  for (let i = modelsIdx + 1; i < endOfProvider; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= modelsIndent) break;
    end = i + 1;
  }
  return { modelsIdx, end, modelsIndent };
}

/** Ids declared as entries of the located models block. */
function declaredIds(lines, block) {
  const ids = new Set();
  for (let i = block.modelsIdx + 1; i < block.end; i++) {
    const m = lines[i].match(/^\s*-\s*id:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** A declaration entry for one model id. Capability metadata (contextWindow,
 * maxTokens) is deliberately absent: the script cannot know the real values
 * per id, and a false capability is worse than the harness's own default. */
function entryLines(id, indent) {
  const pad = " ".repeat(indent + 2);
  return [
    `${pad}- id: ${id}`,
    `${pad}  reasoningEfforts:`,
    `${pad}    off: none`,
    `${pad}    low: low`,
    `${pad}    medium: medium`,
    `${pad}    high: high`,
    `${pad}    max: max`,
  ];
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
  fail(`cannot read ${SETTINGS} — is DSH installed on this machine?`);
}
const lines = settingsText.split("\n");
const block = modelsBlock(lines);
const declared = declaredIds(lines, block);

let roleFiles;
try {
  roleFiles = (await readdir(ROLES_DIR)).filter((f) => f.endsWith(".md") && f !== "README.md");
} catch (error) {
  fail(`cannot read the roles directory ${ROLES_DIR} (${error.code ?? error.message})`);
}

const checks = [];
for (const file of roleFiles) {
  const role = file.replace(/\.md$/, "");
  const raw = await readPin(file);
  if (raw === null) {
    console.log(`− ${role}: no pin — inherits the session model via plain subagent; nothing to check`);
    continue;
  }
  const value = raw.trim();
  if (value === "lite")
    fail(`${role}: pin value "lite" has no DSH mapping — make the pin concrete in .zcode/agents/${file}`);
  if (value === "inherit") {
    console.log(`− ${role}: inherit — resolves to the session model via plain subagent; nothing to check`);
    continue;
  }
  checks.push({ label: role, id: pinToModelId(value) });
}
for (const id of extraIds) checks.push({ label: "(--check)", id });

let served = null;
let servedNote = "";
try {
  served = await servedIdSet();
} catch (error) {
  servedNote = `catalog unreachable (${String(error).slice(0, 80)}) — served-check skipped`;
}

let failures = 0;
const notDeclared = new Set();
const notServed = new Set();
for (const { label, id } of checks) {
  const parts = [];
  let failed = false;
  if (declared.has(id)) parts.push("declared");
  else {
    parts.push("NOT DECLARED");
    notDeclared.add(id);
    failed = true;
  }
  if (served === null) parts.push("served=unknown");
  else if (served.has(id)) parts.push("served");
  else {
    parts.push("NOT SERVED");
    notServed.add(id);
    failed = true;
  }
  if (failed) failures++;
  const icon = failed ? "✗" : "✓";
  console.log(`${icon} ${label}: ${id} — ${parts.join(", ")}`);
}

if (servedNote) console.log(`⚠ ${servedNote}`);

if (failures > 0) {
  // Ids the catalog does not serve: declaring cannot fix them, so --fix
  // never writes for them — the adapter's "re-run until green" loop must
  // not be able to append duplicate entries forever.
  for (const id of notServed) {
    console.log(
      `  fix: ollama.com does not serve "${id}" — declaring cannot fix this; change the pin in the role file or the provider, never reroute silently.`,
    );
  }
  // Declarable ids: undeclared and not known-unserved.
  const declarable = [...notDeclared].filter((id) => !notServed.has(id));
  if (declarable.length > 0 && fix && !dryRun) {
    for (const id of declarable) {
      lines.splice(block.end, 0, ...entryLines(id, block.modelsIndent));
      console.log(`+ declared ${id} in ${SETTINGS} (DSH hot-reloads the file)`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    await writeFile(`${SETTINGS}.bak-${stamp}`, settingsText);
    await writeFile(`${SETTINGS}.tmp`, lines.join("\n"));
    await rename(`${SETTINGS}.tmp`, SETTINGS);
    console.log(`ℹ backup at ${SETTINGS}.bak-${stamp}; re-run without --fix to confirm all pins resolve (hot-reload is async).`);
  } else if (declarable.length > 0) {
    const mode = dryRun ? "would declare" : "run with --fix to declare";
    for (const id of declarable) {
      console.log(`  fix: ${mode} ${id} in ${SETTINGS} — never reroute the pin.`);
    }
  }
  console.error(`✗ ${failures} of ${checks.length} check(s) failed`);
  process.exit(1);
}
console.log(`✓ all ${checks.length} checked pin(s) resolve on DSH`);
