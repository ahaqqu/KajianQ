#!/usr/bin/env bun
// zcode-pin-check.mjs — verify every role-agent model pin resolves on ZCode.
//
// The role agents' model pins live in .zcode/agents/<role>.md frontmatter
// (the single source of truth for every harness). On ZCode a pin of the form
// `<providerId>/<model>` resolves only if the client's provider config
// (~/.zcode/v2/config.json, the "provider" object) carries a provider entry
// **keyed** `<providerId>` that declares `<model>` in its model list. A
// key-list mismatch fails the spawn at dispatch time with "Model provider is
// not configured" (reproduced live 2026-08-30 — see ADR-0005's known-gap note)
// — so this gate checks the pin against the config the client loads, exactly
// the way dsh:preflight checks DSH pins against ~/.dsh/settings.yaml.
//
// Limitations (deliberate): a green run verifies the config file, not the
// running client — the client may cache its provider registry from startup,
// so a config fixed mid-session can still fail until restart. And the gate
// checks the key/model pair, not credentials or reachability of the provider.
//
// Exit 0 when every checked pin resolves; exit 1 with the exact fix printed
// otherwise. The fix is manual (edit the provider config / add the provider
// key in Settings) — this script never writes the client config: the entry
// carries credentials and its UUID keying is owned by the client UI, not us.
// Extra model ids are checked via an explicit `--check <provider>/<model>`.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLES_DIR = join(import.meta.dir, "..", ".zcode", "agents");
const CONFIG = join(homedir(), ".zcode", "v2", "config.json");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const extraRefs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--check") {
    const ref = argv[++i];
    if (!ref) fail("--check requires a model ref: --check <providerId>/<model>");
    extraRefs.push(ref);
  } else if (!a.startsWith("--")) {
    fail(`unexpected argument "${a}" — extra refs are checked via --check <providerId>/<model>, never positionally`);
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

let config;
try {
  config = JSON.parse(await readFile(CONFIG, "utf8"));
} catch (error) {
  fail(`cannot read or parse ${CONFIG} (${error.code ?? error.message}) — is the ZCode client installed?`);
}
const providers = config.provider ?? {};
/** Model list of a provider entry; ZCode builtin providers list their models
 * under "models"; entries without a list cannot pin and count as empty. */
const modelsOf = (entry) => new Set(Object.keys(entry?.models ?? {}));

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
    console.log(`− ${role}: no pin — ZCode uses the session default; nothing to check`);
    continue;
  }
  const value = raw.trim();
  if (value === "inherit") {
    console.log(`− ${role}: inherit — ZCode uses the session default; nothing to check`);
    continue;
  }
  if (value === "lite")
    fail(`${role}: pin value "lite" has no verified ZCode provider mapping — make the pin concrete in .zcode/agents/${file}`);
  checks.push({ label: role, ref: value });
}
for (const ref of extraRefs) checks.push({ label: "(--check)", ref });

if (checks.length === 0) {
  console.log("✓ no pinned roles to check");
  process.exit(0);
}

let failures = 0;
for (const { label, ref } of checks) {
  const providerId = ref.includes("/") ? ref.split("/")[0] : "(session default provider)";
  const modelId = ref.split("/").pop() ?? ref;
  const entry = providers[providerId];
  let verdict;
  if (!ref.includes("/")) {
    verdict = "✗ bare model id — ZCode resolves it against the session default provider, which this static gate cannot read; pin it as <providerId>/<model>";
    failures++;
  } else if (!entry) {
    verdict = `✗ provider key "${providerId}" is not configured in ${CONFIG} — add or rename the provider entry so its key matches the pin's providerId (spawn fails with "Model provider is not configured")`;
    failures++;
  } else if (!modelsOf(entry).has(modelId)) {
    verdict = `✗ provider "${providerId}" does not declare model "${modelId}" — add it to that provider's model list in the client's provider settings`;
    failures++;
  } else {
    verdict = `✓ provider "${providerId}" declares "${modelId}"`;
  }
  console.log(`${label}: ${ref} — ${verdict}`);
}

if (failures > 0) {
  console.error(
    `✗ ${failures} of ${checks.length} pin(s) cannot resolve on ZCode — fix the provider config, never reroute the pin (ADR-0005). Note: a config fixed mid-session needs a client restart before spawns honor it.`,
  );
  process.exit(1);
}
console.log(`✓ all ${checks.length} pinned role(s) resolve in the ZCode provider config (${CONFIG})`);
