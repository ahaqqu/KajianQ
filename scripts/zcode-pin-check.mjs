#!/usr/bin/env bun
// zcode-pin-check.mjs — verify every role-agent model pin resolves on ZCode
// and every dispatched role pins a valid `thoughtLevel` variant.
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
//
// Every dispatched role must also pin `thoughtLevel:` (the reasoning variant).
// ZCode resolves the variant from the provider's `defaultVariant` when the
// profile pins only `model:` — GLM-5.3 ships `defaultVariant: "max"`, and an
// unpinned dispatch ran an entire implementation at `max` instead of the
// intended `high` (issues #94/#96). So this gate fails when a role file omits
// `thoughtLevel:` or pins a value outside the set the harness validates
// (low/medium/high/xhigh/max), and when a dispatched role (DISPATCHED_ROLES
// below, matched by file name) pins anything other than `high` — fork-added
// or renamed roles only need a value from the validated set. It cannot read
// the client's runtime variant choice — for recorded evidence, check the
// telemetry DB's variant column after a real dispatch (issue #96).
//
// Template/fork coupling: this script lives in scripts/, which template-sync
// owns (`overwrite` in template-sync.json), while .zcode/agents/ is
// project-owned — forks inherit this gate but cannot edit it without failing
// `bun run template-gate`, so a fork adding its own role file must pin
// `thoughtLevel:` there (any validated value; the six dispatched roles must
// pin `high`) or `bun run zcode:preflight` fails.
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

/** Reasoning variants the harness validates `thoughtLevel:` against. */
const THOUGHT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Roles the manager dispatches (the pinned-defaults table in
 * .zcode/agents/README.md); these must pin exactly `thoughtLevel: high`.
 * Matched by role-file name, so fork-added or renamed roles fall back to the
 * THOUGHT_LEVELS set check. */
const DISPATCHED_ROLES = new Set([
  "implementer",
  "senior-implementer",
  "reviewer",
  "thermo-nuclear-review-subagent",
  "thermo-nuclear-code-quality-review-subagent",
  "assistant-manager",
]);

/** Hardcoded per-field frontmatter patterns — a RegExp built from the `key`
 * argument would trip semgrep's non-literal-regexp rule, and there are only
 * two fields to read. Line-bounded (`[ \t]*` + `(.*)`) so an empty field
 * value stays empty instead of `\s*` capturing the next frontmatter line;
 * global so duplicated keys are all visible (YAML resolves last-wins). */
const FRONTMATTER_FIELDS = {
  model: /^model:[ \t]*(.*)[ \t]*$/gm,
  thoughtLevel: /^thoughtLevel:[ \t]*(.*)[ \t]*$/gm,
};

/** Read a role file's frontmatter body, or null when the file carries none. */
async function readFrontmatter(file) {
  let text;
  try {
    text = await readFile(join(ROLES_DIR, file), "utf8");
  } catch (error) {
    fail(`cannot read ${join(ROLES_DIR, file)} (${error.code ?? error.message})`);
  }
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null;
}

/** Trimmed value of every occurrence of a frontmatter field, in file order.
 * Empty occurrences are dropped, so an empty `key:` counts as absent. */
function fieldValues(frontmatter, key) {
  const pattern = FRONTMATTER_FIELDS[key];
  if (!pattern) fail(`unsupported frontmatter key "${key}"`);
  return [...frontmatter.matchAll(pattern)].map((m) => m[1].trim()).filter((v) => v.length > 0);
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
const variantViolations = [];
let variantPins = 0;
for (const file of roleFiles) {
  const role = file.replace(/\.md$/, "");
  const frontmatter = (await readFrontmatter(file)) ?? "";
  const modelValues = fieldValues(frontmatter, "model");
  const raw = modelValues.at(-1) ?? null;
  if (raw === null) {
    console.log(`− ${role}: no pin — ZCode uses the session default; nothing to check`);
  } else if (raw === "inherit") {
    console.log(`− ${role}: inherit — ZCode uses the session default; nothing to check`);
  } else if (raw === "lite") {
    fail(`${role}: pin value "lite" has no verified ZCode provider mapping — make the pin concrete in .zcode/agents/${file}`);
  } else {
    checks.push({ label: role, ref: raw });
  }
  const levelValues = fieldValues(frontmatter, "thoughtLevel");
  if (levelValues.length > 1) {
    variantViolations.push(`${role}: ${levelValues.length} thoughtLevel fields — YAML resolves duplicate keys last-wins, so the pin is ambiguous; delete all but one in .zcode/agents/${file}`);
  }
  const level = levelValues.at(-1) ?? null;
  if (level === null) {
    variantViolations.push(`${role}: no thoughtLevel pin — ZCode resolves the reasoning variant from the provider's defaultVariant when the profile pins only model: (GLM-5.3 ships defaultVariant "max"; issues #94/#96) — pin thoughtLevel in .zcode/agents/${file} (fork-added roles inherit this template-owned gate too: pin the field, never edit the gate)`);
  } else if (!THOUGHT_LEVELS.has(level)) {
    variantViolations.push(`${role}: thoughtLevel "${level}" is not in the set the harness validates (low/medium/high/xhigh/max) — fix the pin in .zcode/agents/${file}`);
  } else if (DISPATCHED_ROLES.has(role) && level !== "high") {
    variantViolations.push(`${role}: dispatched roles pin thoughtLevel: high exactly (got "${level}") — see .zcode/agents/README.md "Thought level"; fix the pin in .zcode/agents/${file}`);
  } else {
    console.log(`✓ ${role}: thoughtLevel ${level} — the variant cannot fall through to the provider default`);
    variantPins++;
  }
}
for (const ref of extraRefs) checks.push({ label: "(--check)", ref });

if (checks.length === 0) {
  console.log("✓ no pinned roles to check");
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
}
if (variantViolations.length > 0) {
  for (const violation of variantViolations) console.error(`✗ ${violation}`);
  console.error(`✗ ${variantViolations.length} thoughtLevel violation(s) — every role file in .zcode/agents/ must pin thoughtLevel, and the dispatched roles must pin high (issues #94/#96)`);
}
if (failures > 0 || variantViolations.length > 0) process.exit(1);
console.log(
  `✓ all ${checks.length} pinned role model(s) resolve in the ZCode provider config (${CONFIG}); all ${variantPins} thoughtLevel pin(s) are present and within low/medium/high/xhigh/max (dispatched roles: exactly high)`,
);
