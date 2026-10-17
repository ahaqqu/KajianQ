#!/usr/bin/env bun
// dsh-pin-check.mjs — verify every role-agent model pin is expressible on DSH.
//
// The role agents' model pins live in .zcode/agents/<role>.md frontmatter (the
// single source of truth for every harness). On DSH the config is a stack of
// patch layers, so this check reads the tree the harness composes: the bundle
// layers named by the profile's package.json `dsh.profile.bundles` (each
// bundle's own `dsh.bundle.patch` files, in order), then the profile's
// `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`. A layer replaces an
// entry's named keys wholesale — no deep merge — so the last layer that touches
// an entry owns it. `--patch` overlays are argv-scoped and invisible here: the
// output names every file this check composed.
//
// A layer this check cannot read is fatal, never silently skipped — and where
// that differs from the harness, it differs deliberately:
//
//   - A present profile or home patch that cannot be read or parsed fails loud
//     at boot (`loadOptionalPatches`) and is fatal here. No divergence; an
//     absent one contributes no layer in either.
//   - A bundle named in `dsh.profile.bundles` that the install cannot resolve
//     is a `skippedBundles` note there, and the harness boots on. This check is
//     fatal: the bundle's layers could carry the catalog or the policy, so a
//     verdict built without them is a verdict about another tree.
//   - A patch file a bundle's own `dsh.bundle.patch` list declares but that is
//     absent drops that whole bundle there — `loadOverlayPatches` throws on a
//     missing file inside the bundle's `try` — and the harness boots on. This
//     check is fatal too, so it never composes a bundle's other files into a
//     partial stack.
//
// The one boundary this check cannot see: the harness also drops a bundle whose
// plugins fail its peer-compatibility check, which this check does not evaluate
// — it composes what the harness would skip.
//
// A pin is expressible only when both of these hold in that composed tree:
//
//   1. the id is declared in the provider catalog
//      `llm-pi-ai.providers.ollama.models` and served by ollama.com;
//   2. the route `ollama/<id>` is selectable: either the policy entry
//      `subagent-model-selection-settings` is enabled and lists that route in
//      `allowedModels`, or — with no policy in force — the pin's route is the
//      composed `agent-default-model` route, which a plain dispatch inherits.
//
// The second half is not cosmetic. `selectForSession` yields no policy while
// the policy is not enabled, and the delegation tool is then installed with
// model selection disabled: its `provider`/`model`/`reasoning_effort`
// parameters are absent, and supplying one throws. So with no policy in force a
// dispatch cannot name a route or an effort at all; it inherits the session
// route and effort. A pin equal to the composed default route is honored by
// inheritance; any other pin would run a different model than it names — the
// silent substitution this gate exists to catch — and enabling the policy is
// what makes the pin's `thoughtLevel` nameable again.
//
// A failure is fixed by editing the layer that owns the entry, never by
// rerouting the pin: a per-harness fallback forks the pin truth and makes the
// run silently weaker than the pin declares. An id the catalog does not serve
// cannot be fixed by declaring it — that failure means the pin or the provider
// must change. `--fix` declares missing catalog ids in the owning user layer
// only: atomically, after a timestamped backup, with every id validated first,
// and never the route policy, whose narrowing is an owner-side settings edit.
//
// Pin values may be quoted (the ZCode editor writes them that way) or bare, and
// carry either shape it writes — `<uuid>/<id>:cloud` or
// `custom:<uuid>:<id>%3Acloud`; both normalize to the same id. `inherit` (and
// a missing `model:` field) resolves to the session model via a plain
// `subagent` dispatch — noted, not pin-checked. `lite` has no DSH mapping and
// fails the gate: make the pin concrete.
//
// Exit 0 when every checked pin resolves; exit 1 with the exact fix printed
// otherwise. `--dry-run` prints what `--fix` would append without writing.
// Extra model ids are checked only via an explicit `--check <id>` flag — bare
// positional arguments are rejected: this script can write a global config and
// must not act on a mistyped flag.
//
// Test seams, set together to run against fixtures instead of this machine:
// DSH_PIN_CHECK_HOME (the harness home; its home layer is
// `<home>/cordis.patch.yml`), DSH_PIN_CHECK_PROFILE_DIR (the profile directory
// holding `package.json` and `cordis.patch.yml`), DSH_PIN_CHECK_INSTALL (the
// dsh package directory or its `package.json` — the first bundle-resolution
// anchor), DSH_PIN_CHECK_ROLES_DIR (the role-file directory), and
// DSH_PIN_CHECK_CATALOG (a catalog JSON file with the API's `{ data: [{ id }] }`
// shape, replacing the network fetch). The three config roots are
// all-or-nothing, and the two read-only seams require all three: redirecting
// one root while another stays real is the one state in which a fixture run can
// read — and with `--fix` write — this machine's config.
//
// This is a dispatch-time preflight for the manager's DSH adapter, not a CI
// gate: it depends on this machine's DSH install and ollama.com reachability.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  addBundleLayers,
  addLayer,
  CATALOG_ENTRY,
  composeLayers,
  DEFAULT_ROUTE_ENTRY,
  failConfig,
  findEntry,
  layers,
  patchTouches,
  POLICY_ENTRY,
  probe,
  resolveInstallAnchor,
  SEAM_INSTALL,
  unquote,
} from "./lib/dsh-compose.mjs";
import {
  blockUnder,
  entryBlock,
  entryLines,
  policyPatchLines,
  readLayerLines,
  replaceLayerFile,
} from "./lib/dsh-patch-edit.mjs";

const SEAM_HOME = "DSH_PIN_CHECK_HOME";
const SEAM_PROFILE_DIR = "DSH_PIN_CHECK_PROFILE_DIR";
const SEAM_ROLES_DIR = "DSH_PIN_CHECK_ROLES_DIR";
const SEAM_CATALOG = "DSH_PIN_CHECK_CATALOG";
const CONFIG_ROOTS = [SEAM_HOME, SEAM_PROFILE_DIR, SEAM_INSTALL];
const READ_SEAMS = [SEAM_ROLES_DIR, SEAM_CATALOG];

const HOME = resolve(process.env[SEAM_HOME] ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const PROFILE_DIR = resolve(
  process.env[SEAM_PROFILE_DIR] ??
    process.env.DSH_PROFILE_DIR ??
    join(HOME, "profiles", process.env.DSH_PROFILE ?? "web"),
);
const PROFILE_MANIFEST = join(PROFILE_DIR, "package.json");
const PROFILE_PATCH = join(PROFILE_DIR, "cordis.patch.yml");
const HOME_PATCH = join(HOME, "cordis.patch.yml");
const ROLES_DIR = process.env[SEAM_ROLES_DIR] ?? join(import.meta.dir, "..", ".zcode", "agents");
const CATALOG_FILE = process.env[SEAM_CATALOG] ?? null;
const CATALOG = "https://ollama.com/v1/models";
const PROVIDER = "ollama";
/** The preset chain that carries the delegation tool's own selection switch:
 * the registry entry names the session's default preset, the preset's plugins
 * carry the tool row. */
const PRESET_REGISTRY_ENTRY = "agent-preset-registry";
const PRESET_PLUGIN = "@deepseek-ai/dsh-agent-preset";
const DELEGATION_PLUGIN = "@deepseek-ai/dsh-tool-subagent";
/** The tool name the manager dispatches roles with. */
const DISPATCH_TOOL = "subagent";
/** A model id the script is willing to match or declare: a bare id, never a
 * quoted value, a route, or a path. Anything else is a caller error — and
 * --fix must never write it into the global config. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// The config roots redirect the machine-global read and write paths; the two
// read-only seams redirect only inputs. A run that redirects one root while
// another stays real is the state in which a fixture run can reach — and with
// --fix edit — this machine's config, so the roots are all-or-nothing and the
// read seams require all roots. Enforced before argv is parsed, so --fix cannot
// be reached in that state either.
const setRoots = CONFIG_ROOTS.filter((seam) => process.env[seam]);
const setReads = READ_SEAMS.filter((seam) => process.env[seam]);
if (setReads.length > 0 && setRoots.length < CONFIG_ROOTS.length) {
  const missing = CONFIG_ROOTS.filter((seam) => !process.env[seam]);
  fail(
    `${setReads.join(" and ")} is set without ${missing.join(" and ")} — the test seams are all-or-nothing: with the read paths redirected and a config root left real, this run (and --fix) would act on this machine's ${PROFILE_PATCH} or ${HOME_PATCH}. Set all five seams or none.`,
  );
}
if (setRoots.length > 0 && setRoots.length < CONFIG_ROOTS.length) {
  const missing = CONFIG_ROOTS.filter((seam) => !process.env[seam]);
  fail(
    `${setRoots.join(" and ")} is set without ${missing.join(" and ")} — the config roots are all-or-nothing: with one root redirected and another real, this run (and --fix) could read or edit ${missing.join(" and ")}. Set all five seams or none.`,
  );
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

const INSTALL_ANCHOR = resolveInstallAnchor();
probe(PROFILE_MANIFEST, "unread");
probe(PROFILE_PATCH, "unread");
probe(HOME_PATCH, "unread");

await addBundleLayers({
  anchor: INSTALL_ANCHOR,
  profileDir: PROFILE_DIR,
  profileManifestPath: PROFILE_MANIFEST,
});
await addLayer("profile", "profile", PROFILE_PATCH);
await addLayer("home", "home", HOME_PATCH);

if (layers.length === 0)
  failConfig(
    `no patch layer to compose for profile ${JSON.stringify(basename(PROFILE_DIR))} — nothing declares a catalog or a route policy`,
  );

const { entries, applied, layerOfPatch, ownerOf } = composeLayers(layers);
const source = (layer) => (layer ? layer.file : "no layer in the composed tree");

const catalogEntry = findEntry(entries, CATALOG_ENTRY);
const modelList = catalogEntry?.config?.providers?.[PROVIDER]?.models;
const catalogIds = (Array.isArray(modelList) ? modelList : [])
  .map((model) => model?.id)
  .filter((id) => typeof id === "string" && id.length > 0);
const declared = new Set(catalogIds);
const catalogOwner = ownerOf(CATALOG_ENTRY);

const policyEntry = findEntry(entries, POLICY_ENTRY);
const policyConfig = policyEntry?.config;
const policyEnabled = policyConfig?.enabled === true;
const policyRoutes = new Set(
  (Array.isArray(policyConfig?.allowedModels) ? policyConfig.allowedModels : [])
    .filter((route) => route?.provider && route?.model)
    .map((route) => `${route.provider}/${route.model}`),
);
const policyOwner = ownerOf(POLICY_ENTRY);

const defaultEntry = findEntry(entries, DEFAULT_ROUTE_ENTRY);
const defaultConfig = defaultEntry?.config;
const defaultRoute =
  typeof defaultConfig?.provider === "string" && typeof defaultConfig?.model === "string"
    ? {
        provider: defaultConfig.provider,
        model: defaultConfig.model,
        effort:
          typeof defaultConfig.reasoningEffort === "string" ? defaultConfig.reasoningEffort : null,
      }
    : null;
const defaultOwner = ownerOf(DEFAULT_ROUTE_ENTRY);

/** The second switch, the one the settings entry alone does not answer: the
 * delegation tool consults `subagentModelSelection` only when its own config
 * carries `modelSelectionSettings: true`, and with the flag off it installs
 * with no policy at all — no `provider`/`model`/`reasoning_effort` parameters
 * and a throw on a supplied one. The row lives in the agent preset a session
 * composes, and the composed tree names that preset only through
 * `agent-preset-registry`'s selected default, so the flag is answered here
 * exactly while that chain is intact and reported unresolved otherwise. */
function selectionSwitch(entries) {
  const registryConfig = findEntry(entries, PRESET_REGISTRY_ENTRY)?.config;
  const presetId = registryConfig?.selectedDefault ?? registryConfig?.default;
  if (typeof presetId !== "string")
    return {
      flag: null,
      why: `no \`${PRESET_REGISTRY_ENTRY}\` config in the composed tree names a default preset`,
    };
  let preset = null;
  const walkPresets = (list) => {
    for (const entry of list) {
      if (entry?.name === PRESET_PLUGIN && entry.config?.id === presetId) preset = entry;
      if (entry?.group && Array.isArray(entry.config)) walkPresets(entry.config);
    }
  };
  walkPresets(entries);
  if (!preset)
    return {
      flag: null,
      preset: presetId,
      why: `the default preset ${JSON.stringify(presetId)} is not in the composed tree`,
    };
  // A preset's `plugins` rows are a plain array, and only `group: true` entries
  // nest — the same rule the harness's own patch map walks by.
  let row = null;
  const walkPlugins = (list) => {
    for (const entry of list) {
      if (
        entry?.name === DELEGATION_PLUGIN &&
        (entry.config?.toolName ?? DISPATCH_TOOL) === DISPATCH_TOOL &&
        entry.disabled !== true
      )
        row = entry;
      if (entry?.group && Array.isArray(entry.config)) walkPlugins(entry.config);
    }
  };
  walkPlugins(preset.config?.plugins ?? []);
  if (!row)
    return {
      flag: null,
      preset: presetId,
      why: `the default preset ${JSON.stringify(presetId)} carries no enabled \`${DELEGATION_PLUGIN}\` row mounting \`${DISPATCH_TOOL}\``,
    };
  return {
    flag: row.config?.modelSelectionSettings === true,
    preset: presetId,
    source: source(ownerOf(preset.id)),
  };
}
const selection = selectionSwitch(entries);
/** In force only with both switches on: the tool reads the settings entry only
 * under its own flag, and that entry must be enabled. */
const policyInForce = policyEnabled && selection.flag === true;
const switchState =
  selection.flag === null
    ? `unresolved (${selection.why})`
    : `${selection.flag} (preset ${JSON.stringify(selection.preset)} from ${selection.source}${selection.flag ? "" : " — the tool ignores the settings entry even when enabled"}; a session booted with another preset carries its own row)`;

const policyState = !policyEntry
  ? `no \`${POLICY_ENTRY}\` entry in the composed tree`
  : policyConfig === undefined
    ? `\`${POLICY_ENTRY}\` carries no config in the composed tree, so the settings plugin's own default composes (assumed \`enabled: false\` — the plugin is not read here)`
    : `\`${POLICY_ENTRY}\` is present but not enabled (${source(policyOwner)})`;

console.log(
  `ℹ composed ${layers.length} patch layer(s) for profile ${JSON.stringify(basename(PROFILE_DIR))}; catalog ${declared.size > 0 ? `${declared.size} model id(s)` : "empty"} from ${source(catalogOwner)}; default route ${defaultRoute ? `${defaultRoute.provider}/${defaultRoute.model} from ${source(defaultOwner)}` : "absent from the composed tree"}; policy ${policyInForce ? `in force — enabled (${source(policyOwner)}) and read` : "not in force"}; ${DELEGATION_PLUGIN}.${DISPATCH_TOOL} modelSelectionSettings ${switchState}`,
);
if (!policyInForce) {
  const whyNot = policyEnabled
    ? `\`${POLICY_ENTRY}\` is enabled, but ${selection.flag === false ? `the delegation tool's \`modelSelectionSettings\` is \`false\` (${selection.source}), so it ignores the entry` : `whether the delegation tool reads it at all is session-dependent and not resolvable from the composed tree (${selection.why})`}`
    : policyState;
  console.log(
    `− no narrowing in force: ${whyNot} — route selection is off, so a delegation cannot name provider/model or reasoning_effort: it inherits the session route and effort, and for a session that has not been switched in the UI those are the composed ${DEFAULT_ROUTE_ENTRY} values (${defaultRoute ? `${defaultRoute.provider}/${defaultRoute.model}${defaultRoute.effort ? `, effort ${defaultRoute.effort}` : ""} from ${source(defaultOwner)}` : "none — no composed default route"}), while a switched session's dispatcher carries that session's own route. A pin resolves only where its own model IS that route, and its thoughtLevel is not named either.`,
  );
}
if (policyEnabled && !policyInForce)
  console.log(
    `⚠ an enabled \`${POLICY_ENTRY}\` is not in force: ${selection.flag === false ? `the delegation tool does not set \`modelSelectionSettings: true\` (${selection.source}), so \`allowedModels\` is ignored` : `the delegation tool's \`modelSelectionSettings\` is not resolvable from the composed tree (${selection.why}), so this check cannot certify that \`allowedModels\` is read`}.`,
  );
if (!policyInForce && defaultRoute === null)
  console.log(
    `⚠ no composed ${DEFAULT_ROUTE_ENTRY} route in the ${layers.length} layer(s) searched: ${layers.map((layer) => layer.file).join(", ")} — with route selection off, no pin can resolve by inheritance either.`,
  );

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
const notInherited = new Set();
const notServed = new Set();
const unresolved = new Set();
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
  const inherited = defaultRoute?.provider === PROVIDER && defaultRoute.model === id;
  if (policyInForce) {
    if (policyRoutes.has(route)) parts.push("allowed");
    else {
      parts.push("NOT ALLOWED");
      notAllowed.add(route);
      failed = true;
    }
  } else if (!policyEnabled || selection.flag === false) {
    // Selection is off in every world this run can see, so the pin passes only
    // by inheritance.
    if (inherited) parts.push("inherited route (no policy in force)");
    else {
      parts.push(
        defaultRoute
          ? "NOT the inherited route (no policy in force)"
          : "no inherited route to resolve to (no policy in force)",
      );
      notInherited.add(route);
      failed = true;
    }
  } else if (policyRoutes.has(route) && inherited) {
    // The policy is enabled and the tool's flag is unresolved: this pin passes
    // whether or not the tool reads the policy, so the verdict holds in both
    // worlds even though the narrowing cannot be certified.
    parts.push("allowed and inherited route (route selection unresolved)");
  } else {
    parts.push(
      `UNRESOLVED — \`${POLICY_ENTRY}\` is enabled and the delegation tool's \`modelSelectionSettings\` is not resolvable from the composed tree (${selection.why})`,
    );
    unresolved.add(route);
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

/** The user layer that owns the composed catalog, when one does. A bundle
 * layer is never edited — its file belongs to the installation, and an upgrade
 * would drop the edit. */
function catalogEditLayer() {
  return catalogOwner && catalogOwner.kind !== "bundle" ? catalogOwner : null;
}

/** The path an owner-side policy edit belongs in: the home layer when it
 * already patches the policy entry (it outranks the profile layer), else the
 * profile's own patch file. This script never writes it. */
function policyEditFile() {
  let file = PROFILE_PATCH;
  for (const patch of applied) {
    if (!patchTouches(patch, POLICY_ENTRY)) continue;
    const layer = layerOfPatch.get(patch);
    if (layer?.kind === "home") file = layer.file;
  }
  return file;
}

if (failures > 0) {
  // Ids the catalog does not serve: declaring cannot fix them, so --fix never
  // writes for them — the adapter's "re-run until green" loop must not be able
  // to append duplicate entries forever.
  for (const id of notServed) {
    console.log(
      `  fix: ollama.com does not serve "${id}" — declaring cannot fix this; change the pin in the role file or the provider, never reroute silently.`,
    );
  }
  // With no policy in force, a declared pin that is not the inherited route
  // cannot be named on a dispatch at all. Enabling the policy is the fix, and
  // it is an owner-side edit: it restores per-pin route AND reasoning_effort
  // naming — but only where the delegation tool reads the policy, so where its
  // own switch is off or unread the fix names that second edit too. An
  // undeclared or unserved id is fixed by its own message instead.
  if ([...notInherited].some((route) => declared.has(route.split("/")[1]))) {
    const file = policyEditFile();
    console.log(
      `  fix: no dispatch can name these route(s) while route selection is off — enable the policy in ${file} with every declared catalog id (it is a narrowing guard, not a filter), never reroute the pin (the pin truth is the role file's):`,
    );
    // Every declared catalog id, deduplicated: the harness rejects a policy
    // that repeats a route, so a duplicate would make the printed block
    // unpasteable.
    for (const line of policyPatchLines([...new Set(catalogIds)].map((id) => `${PROVIDER}/${id}`)))
      console.log(line);
    console.log(
      `    (the default route stays ${defaultRoute ? `${defaultRoute.provider}/${defaultRoute.model}` : "unset"}; enabling also lets a dispatch name the pin's thoughtLevel again)`,
    );
    if (selection.flag !== true)
      console.log(
        selection.flag === false
          ? `    (the second switch: the delegation tool in preset ${JSON.stringify(selection.preset)} does not set \`modelSelectionSettings: true\` (${selection.source}), so it ignores the policy above — set that flag on its \`${DELEGATION_PLUGIN}\` row as well, or the dispatch still cannot name a route)`
          : `    (the second switch: whether the delegation tool reads the policy above is session-dependent and not resolvable from the composed tree — ${selection.why}; set \`modelSelectionSettings: true\` on the \`${DELEGATION_PLUGIN}\` row of the session's preset to be sure)`,
      );
  }
  // An enabled policy whose force this run cannot certify: the pin passes
  // neither as allowed (unread) nor by inheritance, so the fix names both
  // switches rather than asserting either.
  if (unresolved.size > 0) {
    const file = policyEditFile();
    console.log(
      `  fix: \`${POLICY_ENTRY}\` is enabled in the composed tree, but whether the delegation tool reads it is session-dependent and could not be resolved — ${selection.why}. Either set \`modelSelectionSettings: true\` on the \`${DELEGATION_PLUGIN}\` row of the preset the session composes, or route the pin through the composed \`${DEFAULT_ROUTE_ENTRY}\` (${defaultRoute ? `${defaultRoute.provider}/${defaultRoute.model}` : "none composed"}), and re-run: no route can be named on a dispatch while the tool's switch is off, and nothing certifies it is on. The policy edit itself belongs in ${file}.`,
    );
  }
  // Narrowed routes: an owner-side policy edit, never a --fix append and never
  // a rerouted pin. When the policy owner is a user layer, the entry is printed
  // in that file's own shape so it can be pasted verbatim.
  if (notAllowed.size > 0) {
    const file = policyEditFile();
    const lines = await readLayerLines(file);
    const policyBlock = entryBlock(lines, POLICY_ENTRY);
    const allowed = policyBlock
      ? blockUnder(lines, policyBlock.idx + 1, policyBlock.end, "allowedModels", 0)
      : null;
    const ownerEditable = policyOwner && policyOwner.kind !== "bundle" && policyOwner.file === file;
    const allRoutes = [...new Set([...policyRoutes, ...notAllowed])].sort();
    for (const route of notAllowed) {
      const [provider, model] = route.split("/");
      if (ownerEditable && allowed) {
        let dash = allowed.indent + 2;
        for (let i = allowed.idx + 1; i < allowed.end; i++) {
          const m = lines[i].match(/^(\s*)-\s+provider:/);
          if (m) {
            dash = m[1].length;
            break;
          }
        }
        console.log(
          `  fix: add this route to ${POLICY_ENTRY}.allowedModels in ${file} — never reroute the pin:`,
        );
        console.log(`${" ".repeat(dash)}- provider: ${provider}`);
        console.log(`${" ".repeat(dash + 2)}model: ${model}`);
      } else {
        console.log(
          `  fix: add this patch entry to ${file} — it replaces the composed policy config, so it carries every route already allowed — never reroute the pin:`,
        );
        for (const line of policyPatchLines(allRoutes)) console.log(line);
      }
      console.log(
        `    (recorded per session at composition, so the edit reaches new sessions only)`,
      );
    }
  }
  // Declarable ids: undeclared and not known-unserved.
  const declarable = [...notDeclared].filter((id) => !notServed.has(id));
  if (declarable.length > 0) {
    const layer = catalogEditLayer();
    if (layer === null) {
      for (const id of declarable) {
        console.log(
          `  fix: declare ${id} in your own patch layer ${PROFILE_PATCH} as a full \`- id: ${CATALOG_ENTRY}\` entry — the composed catalog comes from ${source(catalogOwner)}, and this script never edits an installed bundle.`,
        );
      }
    } else if (fix && !dryRun) {
      const lines = (await readFile(layer.file, "utf8")).split("\n");
      const catalogBlock = entryBlock(lines, CATALOG_ENTRY);
      const providers = catalogBlock
        ? blockUnder(lines, catalogBlock.idx + 1, catalogBlock.end, "providers", 0)
        : null;
      const provider = providers
        ? blockUnder(lines, providers.idx + 1, providers.end, PROVIDER, providers.indent + 1)
        : null;
      const models = provider
        ? blockUnder(lines, provider.idx + 1, provider.end, "models", provider.indent + 1)
        : null;
      if (!models)
        fail(
          `${layer.file} owns the composed catalog but carries no ${CATALOG_ENTRY} → providers.${PROVIDER}.models list — declare the provider catalog there by hand (a patch replaces an entry's keys wholesale, so a partial list would drop every other model)`,
        );
      let indent = models.indent + 2;
      for (let i = models.idx + 1; i < models.end; i++) {
        const m = lines[i].match(/^(\s*)-\s+id:/);
        if (m) {
          indent = m[1].length;
          break;
        }
      }
      const original = lines.join("\n");
      for (const id of declarable) {
        // Belt and braces: an id is validated before the append, and the set is
        // updated as entries land, so a quoted or duplicate id cannot be written.
        if (!MODEL_ID.test(id) || declared.has(id)) continue;
        const appended = entryLines(id, indent);
        lines.splice(models.end, 0, ...appended);
        models.end += appended.length;
        declared.add(id);
        console.log(`+ declared ${id} in ${layer.file} (DSH hot-reloads the file)`);
      }
      const backup = await replaceLayerFile(layer.file, {
        updated: lines.join("\n"),
        original,
      });
      console.log(
        `ℹ backup at ${backup}; re-run without --fix to confirm all pins resolve (hot-reload is async).`,
      );
    } else {
      const mode = dryRun ? "would declare" : "run with --fix to declare";
      for (const id of declarable) {
        console.log(`  fix: ${mode} ${id} in ${layer.file} — never reroute the pin.`);
      }
    }
  }
  console.error(`✗ ${failures} of ${checks.length} check(s) failed`);
  process.exit(1);
}
console.log(`✓ all ${checks.length} checked pin(s) resolve on DSH`);
