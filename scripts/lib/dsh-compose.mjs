// dsh-compose.mjs — read the cordis-patch layer stack the DSH harness composes.
//
// The stack is the bundles named by the profile `package.json`'s
// `dsh.profile.bundles` — each bundle contributing its own `dsh.bundle.patch`
// files, in order — then the profile `cordis.patch.yml`, then
// `$DSH_HOME/cordis.patch.yml`. A layer replaces an entry's named keys
// wholesale — no deep merge — so the last layer that touches an entry owns it.
//
// The patch semantics below are a port of `@deepseek-ai/dsh-app-boot`'s
// `applyEntryPatches`, kept diffable against the harness: an id-targeted patch
// replaces each named key, an `insert` without an id appends to the entry list
// and with an id appends to that group's `config`, and a patch that matches
// nothing or whose `name` disagrees with its target is skipped.
//
// A layer this module cannot resolve or parse is fatal, never skipped: a
// missing layer could carry the catalog or the policy, so no verdict built on
// it is trustworthy. `dsh-pin-check.mjs`'s header states the three cases in
// which that differs from the harness.
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** The install-anchor seam: the dsh package directory, or its `package.json`. */
export const SEAM_INSTALL = "DSH_PIN_CHECK_INSTALL";
/** The entry ids this tree is read for: the provider catalog, the route policy,
 * and the route a plain dispatch inherits. */
export const CATALOG_ENTRY = "llm-pi-ai";
export const POLICY_ENTRY = "subagent-model-selection-settings";
export const DEFAULT_ROUTE_ENTRY = "agent-default-model";

/** Every path this run consulted, with its outcome, in first-seen order. A
 * "cannot read the config" failure prints the whole list: a moved file is not
 * "DSH is not installed", and the reader needs the paths, not a diagnosis. */
export const probes = [];
export function probe(path, note) {
  const entry = `${path} (${note})`;
  const existing = probes.findIndex((p) => p.startsWith(`${path} (`));
  if (existing === -1) probes.push(entry);
  else probes[existing] = entry;
}

/** The fatal for a config this check cannot read or resolve. It names every
 * path it looked in, then stops: a verdict built on an unknown layer is a
 * wrong verdict. */
export function failConfig(reason) {
  console.error(`✗ ${reason}`);
  console.error("  looked in:");
  for (const entry of probes) console.error(`    ${entry}`);
  console.error(
    "  a moved install is not a broken one: set DSH_HOME / DSH_PROFILE_DIR (or the DSH_PIN_CHECK_* seams) to the paths in use.",
  );
  process.exit(1);
}

/** The dsh installation anchor — the profile's first bundle-resolution anchor.
 * Resolved from a seam, else from the npm global root the dsh launcher itself
 * uses: a standard npm prefix layout holds global packages under
 * `<node prefix>/lib/node_modules`. */
export function resolveInstallAnchor() {
  const seam = process.env[SEAM_INSTALL];
  if (seam) {
    const anchor = seam.endsWith("package.json") ? seam : join(seam, "package.json");
    probe(anchor, "dsh install anchor (seam)");
    return anchor;
  }
  const roots = [];
  const node = Bun.which("node");
  if (node) {
    try {
      roots.push(join(dirname(realpathSync(node)), "..", "lib", "node_modules"));
    } catch {
      /* an unresolvable node binary contributes no root */
    }
  }
  if (process.env.npm_config_prefix)
    roots.push(join(process.env.npm_config_prefix, "lib", "node_modules"));
  for (const root of roots) {
    const candidate = join(root, "@deepseek-ai", "dsh", "package.json");
    if (existsSync(candidate)) {
      probe(candidate, "dsh install anchor");
      return candidate;
    }
    probe(candidate, "no dsh package here");
  }
  return null;
}

/** Resolve one package directory from an anchor, as the harness does: Node's
 * own `resolve.paths` walk from the anchor file, then the first `node_modules`
 * search path carrying the package. */
export function packageDirFromAnchor(anchor, packageName) {
  if (!anchor) return null;
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/** A patch-list file parsed into its entries, or a fatal naming the file. */
export async function loadPatchFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    failConfig(`cannot read the patch layer ${file} (${error.code ?? error.message})`);
  }
  let parsed;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    failConfig(`the patch layer ${file} does not parse as YAML: ${String(error).split("\n")[0]}`);
  }
  if (!Array.isArray(parsed)) failConfig(`the patch layer ${file} is not a list of patch entries`);
  return parsed;
}

/** Apply patch lists to an entry list — the harness's own semantics, ported
 * from `@deepseek-ai/dsh-app-boot`'s `applyEntryPatches`: an id-targeted patch
 * replaces each named key wholesale (never a deep merge); an `insert` without
 * an id appends to the entry list, and with an id appends to that group's
 * `config` array; a patch that matches nothing, or whose `name` disagrees with
 * the target, is skipped. `applied` records the patches that took effect, in
 * order, so an entry's owning layer is the layer of the last applied patch
 * naming it. */
export function applyEntryPatches(data, patches) {
  const entries = structuredClone(data);
  const applied = [];
  if (!patches?.length) return { entries, applied };
  const entryMap = new Map();
  const buildMap = (list) => {
    for (const entry of list) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(entries);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target?.group) continue;
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else entries.push(...insert);
      buildMap(insert);
      applied.push(patch);
      continue;
    }
    if (!id) continue;
    const target = entryMap.get(id);
    if (!target) continue;
    if (name && name !== target.name) continue;
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = value;
    }
    applied.push(patch);
  }
  return { entries, applied };
}

/** The entry with this id anywhere in the composed list, groups included. */
export function findEntry(entries, entryId) {
  const map = new Map();
  const walk = (list) => {
    for (const entry of list) {
      if (entry?.id) map.set(entry.id, entry);
      if (entry?.group && Array.isArray(entry.config)) walk(entry.config);
    }
  };
  walk(entries);
  return map.get(entryId) ?? null;
}

/** An entry id a patch names, whether as its target or as an inserted row. */
export function patchTouches(patch, entryId) {
  if (patch.id === entryId) return true;
  return Array.isArray(patch.insert) && patch.insert.some((row) => row?.id === entryId);
}

/** A YAML scalar with any surrounding quotes removed. */
export function unquote(value) {
  const quoted = value.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : value;
}

/** Every layer composed so far, in composition order. */
export const layers = [];

/** Add one patch layer to the stack. A file that is not there contributes no
 * layer when it is optional — the profile patch and the home layer are, in the
 * harness as here — but a file a bundle's own manifest declares is required:
 * the harness reads a bundle's declared files inside one `try`, so a single
 * unreadable file drops that whole bundle, and composing the bundle's other
 * files instead would be a stack the harness does not have. */
export async function addLayer(kind, label, file, { required = false } = {}) {
  if (!existsSync(file)) {
    probe(file, required ? "declared by its bundle manifest but absent" : "absent");
    if (required)
      failConfig(
        `the bundle ${JSON.stringify(label)} declares the patch file ${file} in its dsh.bundle.patch list, and it is absent — one unreadable declared file drops that whole bundle in the harness (never a partial one), so a stack composed from the bundle's other files is not the harness's: restore the file, or drop it from the bundle's dsh.bundle.patch list`,
      );
    return;
  }
  const patches = await loadPatchFile(file);
  layers.push({ kind, label, file, patches });
  probe(file, `${kind} layer${label === kind ? "" : ` ${label}`}`);
}

/** Resolve the profile manifest's bundles and add their declared patch files,
 * in bundle order and file order — the harness's own composition order. Every
 * bundle named in `dsh.profile.bundles` must resolve: a bundle whose layers are
 * unknown leaves the catalog and the policy unknown too, so it is fatal rather
 * than skipped (the harness reports a skipped bundle and boots on; a pin
 * verdict must not). */
export async function addBundleLayers({ anchor, profileDir, profileManifestPath }) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(profileManifestPath, "utf8"));
    probe(profileManifestPath, "profile manifest");
  } catch (error) {
    probe(profileManifestPath, error.code ?? error.message);
    failConfig(
      `cannot read the composed profile ${profileDir} — ${profileManifestPath} is unreadable (${error.code ?? error.message})`,
    );
  }

  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles) || bundles.some((name) => typeof name !== "string"))
    failConfig(
      `${profileManifestPath} does not carry a list of bundle names under dsh.profile.bundles`,
    );

  for (const packageName of bundles) {
    const dir =
      packageDirFromAnchor(anchor, packageName) ??
      packageDirFromAnchor(profileManifestPath, packageName);
    if (!dir)
      failConfig(
        `cannot resolve the profile bundle ${JSON.stringify(packageName)} from the dsh installation (${anchor ?? "not found"}) or ${profileDir} — its patch layers are unknown, so no pin verdict is trustworthy`,
      );
    const bundleManifestPath = join(dir, "package.json");
    let bundleManifest;
    try {
      bundleManifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));
    } catch (error) {
      failConfig(
        `cannot read the bundle manifest ${bundleManifestPath} (${error.code ?? error.message})`,
      );
    }
    const declared = bundleManifest?.dsh?.bundle?.patch;
    const files = typeof declared === "string" ? [declared] : declared;
    if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== "string"))
      failConfig(
        `the profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle.patch file list in ${bundleManifestPath}`,
      );
    for (const file of files)
      await addLayer("bundle", packageName, resolve(dir, file), { required: true });
  }
}

/** Compose the layer stack into one entry list. Each patch is cloned before
 * composition so an `insert` cannot hand a later patch the parsed layer's own
 * objects; the clone keeps its layer as its identity key, which is how an
 * entry's owning layer is recovered. */
export function composeLayers(layerList) {
  const layerOfPatch = new Map();
  const patchList = [];
  for (const layer of layerList)
    for (const patch of layer.patches) {
      const clone = structuredClone(patch);
      layerOfPatch.set(clone, layer);
      patchList.push(clone);
    }
  const { entries, applied } = applyEntryPatches([], patchList);

  /** The layer that owns an entry: the last applied patch naming it. */
  const ownerOf = (entryId) => {
    for (let i = applied.length - 1; i >= 0; i--) {
      const patch = applied[i];
      if (patchTouches(patch, entryId)) return layerOfPatch.get(patch) ?? null;
    }
    return null;
  };
  return { entries, applied, layerOfPatch, ownerOf };
}
