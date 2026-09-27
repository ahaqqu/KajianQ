#!/usr/bin/env bun
// dsh-pin-check.mjs — verify every role-agent model pin resolves on DSH.
//
// The role agents' model pins live in .zcode/agents/<role>.md frontmatter
// (the single source of truth for every harness). On DSH a pin resolves only
// when both of these hold, in ~/.dsh/settings.yaml:
//
//   1. the id is declared in the provider catalog
//      `llm-pi-ai.providers.ollama.models` and served by ollama.com;
//   2. its route `ollama/<id>` appears in
//      `subagent-model-selection.allowedModels`.
//
// Check 2 is a narrowing guard, not a filter: the route list carries every
// declared catalog id, so it rejects nothing today and exists to catch a
// future narrowing. A pin's id may be declared and still be undispatchable —
// `Error: child LLM route "ollama/<id>" is not allowed for this Session`.
// The list is recorded per session at composition and inherited by its
// children, so a settings edit reaches new sessions only; a script can read
// the configured list, never a session's recorded one.
//
// A failure is fixed by editing the harness config, never by rerouting the
// pin (ADR-0023 decision 3). An id the catalog does not serve cannot be fixed
// by declaring it: that failure means the pin or the provider must change, and
// --fix refuses to write for it.
//
// Pin values may be quoted (the ZCode editor writes them that way) or bare,
// and carry either shape it writes — `<uuid>/<id>:cloud` or
// `custom:<uuid>:<id>%3Acloud`; both normalize to the same id. `inherit` (and
// a missing `model:` field) resolves to the session model via a plain
// `subagent` dispatch — noted, not pin-checked. `lite` has no DSH mapping and
// fails the gate: make the pin concrete.
//
// Exit 0 when every checked pin resolves; exit 1 with the exact fix printed
// otherwise. `--fix` appends missing catalog declarations — atomically (temp
// file + rename), after writing a timestamped backup beside the original (the
// file is a machine-global config no VCS can restore). An id is validated
// before anything is appended, so --fix can never write a quoted id or a
// duplicate; it never writes the route list, whose narrowing is an owner-side
// settings decision. `--dry-run` prints what --fix would append without
// writing. Extra model ids are checked only via an explicit `--check <id>`
// flag — bare positional arguments are rejected: this script writes to a
// global config and must not act on a mistyped flag.
//
// Test seams, set together to run against fixtures instead of this machine:
// DSH_PIN_CHECK_SETTINGS (settings.yaml path), DSH_PIN_CHECK_ROLES_DIR (the
// role-file directory), DSH_PIN_CHECK_CATALOG (a catalog JSON file with the
// API's `{ data: [{ id }] }` shape, replacing the network fetch).
//
// This is a dispatch-time preflight for the manager's DSH adapter, not a CI
// gate: it depends on this machine's DSH install and ollama.com reachability.
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLES_DIR =
  process.env.DSH_PIN_CHECK_ROLES_DIR ?? join(import.meta.dir, "..", ".zcode", "agents");
const SETTINGS = process.env.DSH_PIN_CHECK_SETTINGS ?? join(homedir(), ".dsh", "settings.yaml");
const CATALOG_FILE = process.env.DSH_PIN_CHECK_CATALOG ?? null;
const CATALOG = "https://ollama.com/v1/models";
const PROVIDER = "ollama";
const SELECTION = "subagent-model-selection:";
/** A model id the script is willing to match or declare: a bare id, never a
 * quoted value, a route, or a path. Anything else is a caller error — and
 * --fix must never write it into the global config. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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
    if (!MODEL_ID.test(id))
      fail(
        `--check "${id}" is not a bare model id — pass the id the pin names (e.g. deepseek-v4.1-flash), never a quoted value or a provider route`,
      );
    extraIds.push(id);
  } else if (a.startsWith("--") && !["--fix", "--dry-run"].includes(a)) {
    fail(`unknown flag "${a}" — known flags: --fix, --dry-run, --check <model-id>`);
  } else if (!a.startsWith("--")) {
    fail(
      `unexpected argument "${a}" — extra ids are checked via --check <model-id>, never positionally`,
    );
  }
}

/** A YAML scalar with any surrounding quotes removed. */
function unquote(value) {
  const quoted = value.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : value;
}

/** Read a frontmatter `model:` value (quotes stripped), or null when the file
 * carries none. */
async function readPin(file) {
  let text;
  try {
    text = await readFile(join(ROLES_DIR, file), "utf8");
  } catch (error) {
    fail(`cannot read ${join(ROLES_DIR, file)} (${error.code ?? error.message})`);
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const raw = fm[1].match(/^model:\s*(.+)\s*$/m)?.[1];
  return raw === undefined ? null : unquote(raw.trim());
}

/** A pin value → the concrete model id it names. Shapes seen in
 * `.zcode/agents/`: `<uuid>/<id>:cloud` and the ZCode editor's
 * percent-encoded `custom:<uuid>:<id>%3Acloud`. `ollama/<id>:cloud` (the
 * form the ADRs quote) normalizes the same way. */
function pinToModelId(raw) {
  const value = raw.trim().replace(/%3A/gi, ":");
  const tail =
    value
      .replace(/^custom:[^:]+:/, "")
      .split("/")
      .pop() ?? "";
  return tail.replace(/:cloud$/, "").trim();
}

const indentOf = (line) => line.length - line.trimStart().length;

/** The line range of the top-level `key:` block: its key line, and `end` just
 * past its last content line. The scan stops at the first non-blank line no
 * deeper than the key, so nested lists are inside and the next top-level key
 * is not. Returns null when the file has no such key. */
function topLevelBlock(lines, key) {
  const idx = lines.findIndex((l) => l.trim() === key);
  if (idx === -1) return null;
  const keyIndent = indentOf(lines[idx]);
  let end = idx + 1;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= keyIndent) break;
    end = i + 1;
  }
  return { idx, end };
}

/** The ollama provider's `models:` list, as line indices: { modelsIdx, end,
 * modelsIndent } with `end` just past the last entry. Both the declared-id
 * scan and the --fix insertion are scoped to this block — never to "all text
 * before a marker" — so an unexpected file shape fails loudly instead of
 * splicing entries into the wrong place. */
function modelsBlock(lines) {
  const provider = topLevelBlock(lines, `${PROVIDER}:`);
  if (!provider)
    fail(
      `no "${PROVIDER}:" provider block in ${SETTINGS} — declare the provider before pinning models against it`,
    );
  const rel = lines.slice(provider.idx + 1, provider.end).findIndex((l) => l.trim() === "models:");
  const modelsIdx = rel === -1 ? provider.idx : provider.idx + 1 + rel;
  if (modelsIdx === provider.idx)
    fail(
      `no "models:" list under the ${PROVIDER} provider in ${SETTINGS} — refusing to guess where to declare`,
    );
  const modelsIndent = indentOf(lines[modelsIdx]);
  let end = modelsIdx + 1;
  for (let i = modelsIdx + 1; i < provider.end; i++) {
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
    if (m) ids.add(unquote(m[1]));
  }
  return ids;
}

/** Whether the route policy block turns route selection on. A policy the
 * harness does not enable removes model selection entirely — no
 * `provider`/`model`/`reasoning_effort` on `subagent` — so no pin can be
 * dispatched by route. */
function selectionEnabled(lines, block) {
  for (let i = block.idx + 1; i < block.end; i++) {
    const m = lines[i].match(/^\s*enabled:\s*(\S+)/);
    if (m) return unquote(m[1]) === "true";
  }
  return false;
}

/** Routes the policy allows, as `provider/model`. */
function allowedRoutes(lines, block) {
  const routes = new Set();
  let provider = null;
  for (let i = block.idx + 1; i < block.end; i++) {
    const p = lines[i].match(/^\s*-\s*provider:\s*(\S+)/);
    if (p) {
      provider = unquote(p[1]);
      continue;
    }
    const m = lines[i].match(/^\s*model:\s*(\S+)/);
    if (m && provider !== null) {
      routes.add(`${provider}/${unquote(m[1])}`);
      provider = null;
    }
  }
  return routes;
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
  if (CATALOG_FILE) {
    const json = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
    return new Set(json.data.map((m) => m.id));
  }
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

const selection = topLevelBlock(lines, SELECTION);
if (!selection)
  fail(
    `no "${SELECTION}" block in ${SETTINGS} — route selection is off, so no pinned route can be dispatched; add the policy with every declared catalog id in allowedModels`,
  );
if (!selectionEnabled(lines, selection))
  fail(
    `"${SELECTION}" is not enabled in ${SETTINGS} — with route selection off, no pin can be dispatched by model; set "enabled: true"`,
  );
const routes = allowedRoutes(lines, selection);

let roleFiles;
try {
  roleFiles = (await readdir(ROLES_DIR)).filter((f) => f.endsWith(".md") && f !== "README.md");
} catch (error) {
  fail(`cannot read the roles directory ${ROLES_DIR} (${error.code ?? error.message})`);
}

const checks = [];
for (const file of roleFiles) {
  const role = file.replace(/\.md$/, "");
  const value = await readPin(file);
  if (value === null) {
    console.log(
      `− ${role}: no pin — inherits the session model via plain subagent; nothing to check`,
    );
    continue;
  }
  if (value === "lite")
    fail(
      `${role}: pin value "lite" has no DSH mapping — make the pin concrete in .zcode/agents/${file}`,
    );
  if (value === "inherit") {
    console.log(
      `− ${role}: inherit — resolves to the session model via plain subagent; nothing to check`,
    );
    continue;
  }
  const id = pinToModelId(value);
  if (!MODEL_ID.test(id))
    fail(
      `${role}: pin "${value}" does not name a bare model id (got "${id}") — fix the pin in .zcode/agents/${file}`,
    );
  checks.push({ label: role, id });
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
const notAllowed = new Set();
const notServed = new Set();
for (const { label, id } of checks) {
  const route = `${PROVIDER}/${id}`;
  const parts = [];
  let failed = false;
  if (declared.has(id)) parts.push("declared");
  else {
    parts.push("NOT DECLARED");
    notDeclared.add(id);
    failed = true;
  }
  if (routes.has(route)) parts.push("allowed");
  else {
    parts.push("NOT ALLOWED");
    notAllowed.add(route);
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
  // Narrowed routes: an owner-side settings edit, never a --fix append and
  // never a rerouted pin.
  for (const route of notAllowed) {
    const [provider, model] = route.split("/");
    console.log(
      `  fix: add this route to subagent-model-selection.allowedModels in ${SETTINGS} — never reroute the pin:`,
    );
    console.log(`      - provider: ${provider}`);
    console.log(`        model: ${model}`);
    console.log(`    (recorded per session at composition, so the edit reaches new sessions only)`);
  }
  // Declarable ids: undeclared and not known-unserved.
  const declarable = [...notDeclared].filter((id) => !notServed.has(id));
  if (declarable.length > 0 && fix && !dryRun) {
    for (const id of declarable) {
      // Belt and braces: an id is validated before the append, and the set is
      // updated as entries land, so a quoted or duplicate id cannot be written.
      if (!MODEL_ID.test(id) || declared.has(id)) continue;
      lines.splice(block.end, 0, ...entryLines(id, block.modelsIndent));
      declared.add(id);
      console.log(`+ declared ${id} in ${SETTINGS} (DSH hot-reloads the file)`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    await writeFile(`${SETTINGS}.bak-${stamp}`, settingsText);
    await writeFile(`${SETTINGS}.tmp`, lines.join("\n"));
    await rename(`${SETTINGS}.tmp`, SETTINGS);
    console.log(
      `ℹ backup at ${SETTINGS}.bak-${stamp}; re-run without --fix to confirm all pins resolve (hot-reload is async).`,
    );
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
