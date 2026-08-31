#!/usr/bin/env bun
// zcode-pin-check.mjs — ZCode preflight: structural machinery gate (hard
// failures) + local provider-pin resolution (drift warnings). Issue #125.
//
// Hard failures (exit 1, from scripts/zcode-machinery-check.mjs — the same
// checks `bun run template-gate` enforces, so CI gates them too):
//   - .zcode/config.json hook wiring missing or disabled (guardrail /
//     telemetry hooks),
//   - a role file without a concrete `model: <providerId>/<model>` pin,
//   - a role file without a valid `thoughtLevel:` pin (dispatched roles:
//     exactly high).
//
// Drift warnings (visible, never a gate failure): whether a pin resolves in
// the *local* ZCode provider config. A pin of the form `<providerId>/<model>`
// resolves only if the client's provider config (~/.zcode/v2/config.json, the
// "provider" object) carries a provider entry **keyed** `<providerId>` that
// declares `<model>` in its model list. A key-list mismatch fails the spawn at
// dispatch time with "Model provider is not configured" (reproduced live
// 2026-08-30 — see ADR-0005's known-gap note) — so this gate checks the pin
// against the config the client loads, exactly the way dsh:preflight checks
// DSH pins against ~/.dsh/settings.yaml. But CI has no client config, so a
// non-resolving pin (or an unreadable config) is reported as a warning, not a
// failure: the drift that matters — a stale pin dispatching through a
// non-caching channel while the caching channel sits unused (issue #125) —
// must be visible, and the fix stays local to the machine that owns the
// config. Run this before model-pinned dispatches; a green run with zero
// warnings means every committed pin resolves right here.
//
// Limitations (deliberate): a green run verifies the config file, not the
// running client — the client may cache its provider registry from startup,
// so a config fixed mid-session can still fail until restart (the same
// restart caveat applies to pin edits: new spawns only pick up changed pins
// after a restart). The gate checks the key/model pair, not credentials or
// reachability of the provider. The fix is manual (edit the provider config /
// add the provider key in Settings) — this script never writes the client
// config: the entry carries credentials and its UUID keying is owned by the
// client UI, not us. Extra model ids are checked via `--check <provider>/<model>`.
//
// Template/fork coupling: this script and .zcode/ are both template-owned
// (`overwrite` in template-sync.json, issue #125) — forks inherit the gate
// and the machinery together; a fork re-pins a model via the user-scope
// override ~/.zcode/agents/<role>.md, never by editing the project file
// (template-gate fails on that drift).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkZcodeMachinery } from "./zcode-machinery-check.mjs";

// Repo root holding .zcode/. ZCODE_PIN_CHECK_ROOT exists only so the test
// suite can point the gate at a fixture tree (fork-like) — never set it in
// production runs.
const ROOT = process.env.ZCODE_PIN_CHECK_ROOT || join(import.meta.dir, "..");
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

const { errors, roles } = checkZcodeMachinery(ROOT);

let resolved = 0;
for (const { role, model, thoughtLevel } of roles) {
  console.log(`✓ ${role}: model ${model} (concrete pin), thoughtLevel ${thoughtLevel} — the variant cannot fall through to the provider default`);
  resolved++;
}
if (roles.length === 0 && errors.length === 0) {
  console.log("− no role files with pins found in .zcode/agents/");
}
if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  fail(
    `${errors.length} .zcode/ machinery violation(s) — hook wiring and role pins are template-owned (issue #125): restore with 'bun run template-sync update', re-pin a model via ~/.zcode/agents/<role>.md`,
  );
}

// --- Environment-dependent layer: local provider resolution (warnings only).
let providers = null;
try {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  providers = config.provider ?? {};
} catch (error) {
  console.log(
    `⚠ cannot read or parse ${CONFIG} (${error.code ?? error.message}) — skipping pin resolution (CI has no client config); run locally before model-pinned dispatches to see which pins resolve`,
  );
}
/** Model list of a provider entry; ZCode builtin providers list their models
 * under "models"; entries without a list cannot pin and count as empty. */
const modelsOf = (entry) => new Set(Object.keys(entry?.models ?? {}));

let warnings = 0;
function resolvePin(label, ref) {
  if (!providers) return; // config unreadable — already warned once
  const providerId = ref.split("/")[0];
  const modelId = ref.split("/").pop() ?? ref;
  const entry = providers[providerId];
  let verdict;
  if (!entry) {
    verdict = `provider key "${providerId}" is not configured in ${CONFIG} — add or rename the provider entry so its key matches the pin's providerId (spawn fails with "Model provider is not configured")`;
  } else if (!modelsOf(entry).has(modelId)) {
    verdict = `provider "${providerId}" does not declare model "${modelId}" — add it to that provider's model list in the client's provider settings`;
  } else {
    console.log(`✓ ${label}: ${ref} — provider "${providerId}" declares "${modelId}"`);
    return;
  }
  warnings++;
  console.log(
    `⚠ ${label}: ${ref} — ${verdict} — drift warning, not a gate failure (issue #125: CI cannot see ~/.zcode/v2/config.json); fix it before dispatching or the spawn falls back off the caching channel`,
  );
}

for (const { role, model } of roles) resolvePin(role, model);
for (const ref of extraRefs) resolvePin("(--check)", ref);

if (providers && warnings === 0) {
  console.log(
    `✓ all ${roles.length + extraRefs.length} checked pin(s) resolve in the ZCode provider config (${CONFIG})`,
  );
}
if (warnings > 0) {
  console.log(
    `⚠ ${warnings} pin(s) do not resolve in the local provider config — visible drift (issue #125), exit still 0; fix the config (restart the client afterwards: spawns cache the registry from startup)`,
  );
}
console.log(
  `✓ machinery gate passed: hook wiring present and enabled, ${resolved} role file(s) carry concrete model pins and thoughtLevel pins (dispatched roles: high)`,
);
