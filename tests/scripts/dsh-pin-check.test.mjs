import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * `bun run dsh:preflight` — the role-pin expressibility gate.
 *
 * The gate reads the config the harness composes, so the suite builds the tree
 * the harness builds: a profile `package.json` naming bundles, each bundle's
 * `cordis.patch.yml`, the profile patch layer, and a home-layer patch. What is
 * pinned here:
 *
 * - layer precedence and last-layer-wins for both the catalog and the policy,
 *   with the harness's shallow key replacement: a bundle's declared ids are
 *   gone once a later layer replaces `llm-pi-ai`'s config — merged, they would
 *   still resolve;
 * - an enabled policy in a *bundle* layer narrows routes, so the resolver has
 *   to read every layer rather than the user's own;
 * - a patch whose `name` disagrees with its target is skipped, exactly as the
 *   harness skips it;
 * - the verdict branches: an undeclared id FAILS with a paste-safe fix; a
 *   declared route outside an enabled policy's `allowedModels` FAILS (the
 *   narrowing guard stays load-bearing); no policy in force exits 0 with the
 *   "no narrowing" note when the pin IS the composed default route, and FAILS
 *   with the owner-side policy block when it is not — a dispatch cannot name a
 *   route at all, so any other pin would run a model it does not name;
 * - a genuinely absent config exits 1 naming every path it looked in, and an
 *   unresolvable or unparsable layer is fatal rather than skipped;
 * - a stale settings backup or an imported legacy document is never the source
 *   of a verdict;
 * - `--fix` writes the owning user layer only — atomically, behind a backup,
 *   refusing a quoted or duplicate id — and refuses an installed bundle;
 * - the seams are all-or-nothing, and the machine's real composed profile patch
 *   and home layer are re-read byte for byte after the suite, so a fixture run
 *   that reached them fails here.
 *
 * Every run goes through `runPreflight`, which sets all five seams and refuses
 * a fixture path outside the fixture root. That is the second layer of the
 * safety boundary; the first is the script's own all-or-nothing guard, which
 * refuses a run that redirects one config root while another stays real
 * (`--fix` included).
 */

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/dsh-pin-check.mjs");
const REAL_HOME = resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const REAL_PROFILE_DIR = resolve(
  process.env.DSH_PROFILE_DIR ?? join(REAL_HOME, "profiles", process.env.DSH_PROFILE ?? "web"),
);
const REAL_PROFILE_PATCH = join(REAL_PROFILE_DIR, "cordis.patch.yml");
const REAL_HOME_PATCH = join(REAL_HOME, "cordis.patch.yml");
/** The files `--fix` must never touch: the config this machine actually
 * composes. */
const realBefore = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const REAL_PROFILE_BEFORE = realBefore(REAL_PROFILE_PATCH);
const REAL_HOME_BEFORE = realBefore(REAL_HOME_PATCH);

const SEAMS = [
  "DSH_PIN_CHECK_HOME",
  "DSH_PIN_CHECK_PROFILE_DIR",
  "DSH_PIN_CHECK_INSTALL",
  "DSH_PIN_CHECK_ROLES_DIR",
  "DSH_PIN_CHECK_CATALOG",
];

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  if (REAL_PROFILE_BEFORE !== null)
    expect(readFileSync(REAL_PROFILE_PATCH, "utf8")).toBe(REAL_PROFILE_BEFORE);
  else expect(existsSync(REAL_PROFILE_PATCH)).toBe(false);
  if (REAL_HOME_BEFORE !== null)
    expect(readFileSync(REAL_HOME_PATCH, "utf8")).toBe(REAL_HOME_BEFORE);
  else expect(existsSync(REAL_HOME_PATCH)).toBe(false);
});

const UUID = "d5585e04-940a-41f6-a9ec-320bb4fccd7e";
/** The ZCode editor's pin shape for an id. */
const pinFor = (id) => `${UUID}/${id}:cloud`;
const PIN_SLASH = pinFor("deepseek-v4.1-flash");
const PIN_CUSTOM = `custom:${UUID}:deepseek-v4.1-flash%3Acloud`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-pin-check-"));
  roots.push(root);
  const fx = {
    root,
    home: join(root, "home"),
    profile: join(root, "profile"),
    install: join(root, "install"),
    roles: join(root, "agents"),
    catalog: join(root, "catalog.json"),
  };
  for (const dir of [fx.home, fx.profile, fx.install, fx.roles])
    mkdirSync(dir, { recursive: true });
  return fx;
}

const indent = (text, spaces) =>
  text
    .split("\n")
    .map((line) => (line ? " ".repeat(spaces) + line : line))
    .join("\n");

/** A bundle layer that inserts entries — the shipped bundles' shape, so the
 * insert path of the patch semantics is the one exercised. */
const insertEntries = (...entries) =>
  `- insert:\n${entries.map((entry) => indent(entry, 4)).join("")}`;

/** The provider-catalog patch entry, in the live file's block shape: `models:`
 * at eight spaces and its `- id:` entries at ten. `name` is overridable so a
 * name-mismatched patch can be exercised. */
function catalogEntry(declared, { name = "@deepseek-ai/dsh-llm-pi-ai" } = {}) {
  return [
    "- id: llm-pi-ai",
    `  name: '${name}'`,
    "  config:",
    "    providers:",
    "      ollama:",
    "        apiKeyEnv: OLLAMA_API_KEY",
    "        models:",
    ...declared.map((id) => `          - id: ${id}\n            contextWindow: 1000000`),
    "",
  ].join("\n");
}

function defaultRouteEntry(provider, model, effort = "max") {
  return [
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    `    provider: ${provider}`,
    `    model: ${model}`,
    `    reasoningEffort: ${effort}`,
    "",
  ].join("\n");
}

/** The settings entry the web bundle inserts: present, with no config, so the
 * plugin defaults (`enabled: false`, `allowedModels: []`) are what composes. */
function policySettingsInsert() {
  return [
    "- id: subagent-model-selection-settings",
    "  name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    "",
  ].join("\n");
}

/** A policy config patch: `enabled` plus the routes it allows. */
function policyEntry({ enabled = true, routes = [] }) {
  return [
    "- id: subagent-model-selection-settings",
    "  config:",
    `    enabled: ${enabled}`,
    "    allowedModels:",
    ...routes.map((route) => {
      const [provider, model] = route.split("/");
      return `      - provider: ${provider}\n        model: ${model}`;
    }),
    "",
  ].join("\n");
}

function writeBundle(fx, name, patches, { anchor = "install" } = {}) {
  const dir = join(anchor === "install" ? fx.install : fx.profile, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        dsh: { bundle: { patch: patches.map((_, i) => `./patch-${i}.yml`) } },
      },
      null,
      2,
    )}\n`,
  );
  patches.forEach((text, i) => writeFileSync(join(dir, `patch-${i}.yml`), text));
  return dir;
}

function writeProfile(fx, bundles, patchText) {
  writeFileSync(
    join(fx.profile, "package.json"),
    `${JSON.stringify({ name: "fixture-profile", private: true, dsh: { profile: { bundles } } }, null, 2)}\n`,
  );
  if (patchText !== undefined) writeFileSync(join(fx.profile, "cordis.patch.yml"), patchText);
}

function writeHome(fx, text) {
  writeFileSync(join(fx.home, "cordis.patch.yml"), text);
}

function writeRole(fx, role, frontmatter) {
  writeFileSync(join(fx.roles, `${role}.md`), `---\n${frontmatter}\n---\n\nRole body.\n`);
}

function writeCatalog(fx, ids) {
  writeFileSync(fx.catalog, `${JSON.stringify({ data: ids.map((id) => ({ id })) }, null, 2)}\n`);
}

/** The common composed profile: one bundle inserting the catalog, the default
 * route and (optionally) the settings entry, plus the profile patch. */
function composeBase(
  fx,
  { declared = ["alpha-model"], model = declared[0], policySettings = true, profilePatch } = {},
) {
  writeBundle(fx, "fixture-bundle-base", [
    insertEntries(
      catalogEntry(declared),
      defaultRouteEntry("ollama", model),
      ...(policySettings ? [policySettingsInsert()] : []),
    ),
  ]);
  writeProfile(fx, ["fixture-bundle-base"], profilePatch);
  return fx;
}

function runPreflight(fx, args = []) {
  for (const path of [fx.profile, fx.home, fx.install, fx.roles, fx.catalog])
    expect(resolve(path).startsWith(resolve(fx.root))).toBe(true);
  expect(resolve(fx.profile)).not.toBe(resolve(REAL_PROFILE_DIR));
  expect(resolve(fx.home)).not.toBe(REAL_HOME);
  const res = spawnSync("bun", [SCRIPT, ...args], {
    env: {
      ...process.env,
      DSH_PIN_CHECK_HOME: fx.home,
      DSH_PIN_CHECK_PROFILE_DIR: fx.profile,
      DSH_PIN_CHECK_INSTALL: fx.install,
      DSH_PIN_CHECK_ROLES_DIR: fx.roles,
      DSH_PIN_CHECK_CATALOG: fx.catalog,
    },
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    out: `${res.stdout}${res.stderr}`,
  };
}

/** Every backup the run left beside a file, newest last. */
const backupsOf = (file) =>
  readdirSync(dirname(file))
    .filter((entry) => entry.startsWith(`${basename(file)}.bak-`))
    .map((entry) => join(dirname(file), entry));

/** The printed fix block, as it appears in stdout: its two lines with their
 * own indentation, ready to be pasted into `allowedModels`. */
function printedEntry(stdout, provider, model) {
  const m = stdout.match(new RegExp(`^( *)- provider: ${provider}\\n( *)model: ${model}$`, "m"));
  if (!m) throw new Error(`no printed ${provider}/${model} entry in:\n${stdout}`);
  return { block: m[0], dash: m[1].length, model: m[2].length };
}

/** Parse a YAML text with Bun's parser and return the composed entry list — the
 * same reader the harness's own dialect is checked against. */
function parseEntries(text) {
  const res = spawnSync(
    "bun",
    [
      "-e",
      'const text = require("node:fs").readFileSync(0, "utf8");console.log(JSON.stringify(Bun.YAML.parse(text)));',
    ],
    { input: text, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`YAML parse failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** Paste a printed block verbatim at the end of a layer file — the operator's
 * paste — and parse the result. The gate's contract is that the printed entry
 * is paste-safe as printed: at the wrong depth the file stops parsing, which
 * would take the whole harness config down with it. */
function pasteAndParse(file, block) {
  return parseEntries(`${readFileSync(file, "utf8")}${block}\n`);
}

const findEntry = (entries, id) => entries.find((entry) => entry?.id === id);

describe("test seams", () => {
  it("refuses a partial seam redirection instead of falling through to the real config", () => {
    const fx = fixture();
    writeRole(fx, "reviewer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);
    // HOME is redirected as well, so this test is safe to run even when it is
    // red: without the guard the script would read (and with --fix write) the
    // empty temp-home path, never the owner's real file.
    const fakeHome = join(fx.root, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    const baseEnv = { ...process.env, HOME: fakeHome };
    for (const seam of SEAMS) delete baseEnv[seam];

    // A read-only seam without the config roots: --fix would write the real
    // profile patch or home layer.
    const reads = spawnSync("bun", [SCRIPT, "--fix"], {
      env: { ...baseEnv, DSH_PIN_CHECK_ROLES_DIR: fx.roles },
      encoding: "utf8",
    });
    expect(reads.status).toBe(1);
    expect(reads.stderr).toContain("DSH_PIN_CHECK_ROLES_DIR is set without");
    expect(reads.stderr).toContain(
      "DSH_PIN_CHECK_HOME and DSH_PIN_CHECK_PROFILE_DIR and DSH_PIN_CHECK_INSTALL",
    );
    expect(reads.stdout).not.toContain("+ declared");

    // One redirected config root while the others stay real: the same hazard.
    const root = spawnSync("bun", [SCRIPT, "--fix"], {
      env: { ...baseEnv, DSH_PIN_CHECK_PROFILE_DIR: fx.profile },
      encoding: "utf8",
    });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain("the config roots are all-or-nothing");
    expect(root.stdout).not.toContain("+ declared");
    expect(existsSync(join(fakeHome, ".dsh"))).toBe(false);
  });
});

describe("composed layer stack", () => {
  it("composes bundle, profile and home layers in order, the last layer owning each entry", () => {
    const fx = fixture();
    // Bundle: catalog alpha+beta, default route alpha, the settings entry.
    writeBundle(fx, "fixture-bundle-base", [
      insertEntries(
        catalogEntry(["alpha-model", "beta-model"]),
        defaultRouteEntry("ollama", "alpha-model"),
        policySettingsInsert(),
      ),
    ]);
    // Profile layer: replaces the catalog (beta is gone, not merged) and the
    // default route.
    writeProfile(
      fx,
      ["fixture-bundle-base"],
      catalogEntry(["gamma-model"]) + defaultRouteEntry("ollama", "gamma-model"),
    );
    // Home layer: outranks the profile layer for the policy.
    writeHome(fx, policyEntry({ enabled: true, routes: ["ollama/gamma-model"] }));
    writeRole(fx, "alpha", `model: "${pinFor("alpha-model")}"`);
    writeRole(fx, "gamma", `model: "${pinFor("gamma-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model", "gamma-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    // A deep merge would still declare alpha-model; the harness replaces the
    // entry's config wholesale, so it is gone.
    expect(res.stdout).toContain("✗ alpha: alpha-model — NOT DECLARED, NOT ALLOWED, served");
    expect(res.stdout).toContain("✓ gamma: gamma-model — declared, allowed, served");
    expect(res.stdout).toContain(
      `catalog 1 model id(s) from ${join(fx.profile, "cordis.patch.yml")}`,
    );
    expect(res.stdout).toContain(`policy enabled (${join(fx.home, "cordis.patch.yml")})`);
    expect(res.stdout).toContain(
      `default route ollama/gamma-model from ${join(fx.profile, "cordis.patch.yml")}`,
    );
  });

  it("narrows routes from a policy that only a bundle layer carries", () => {
    const fx = fixture();
    writeBundle(fx, "fixture-bundle-base", [
      insertEntries(
        catalogEntry(["alpha-model", "beta-model"]),
        defaultRouteEntry("ollama", "alpha-model"),
        policySettingsInsert(),
      ),
    ]);
    const web = writeBundle(fx, "fixture-bundle-web", [
      policyEntry({ enabled: true, routes: ["ollama/alpha-model"] }),
    ]);
    writeProfile(fx, ["fixture-bundle-base", "fixture-bundle-web"]);
    writeRole(fx, "reviewer", `model: "${pinFor("beta-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model"]);

    const res = runPreflight(fx, ["--fix"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("✗ reviewer: beta-model — declared, NOT ALLOWED, served");
    expect(res.stdout).toContain(`policy enabled (${join(web, "patch-0.yml")})`);
    // The owner layer for the policy is a bundle, so the printed fix is the
    // whole replacement patch entry, in the user's own layer file.
    expect(res.stdout).toContain(
      `fix: add this patch entry to ${join(fx.profile, "cordis.patch.yml")}`,
    );
    expect(res.stdout).toContain("- id: subagent-model-selection-settings");
    expect(res.stdout).toContain("        model: alpha-model");
    expect(res.stdout).toContain("        model: beta-model");
    expect(existsSync(join(fx.profile, "cordis.patch.yml"))).toBe(false);
    expect(backupsOf(join(web, "patch-0.yml"))).toHaveLength(0);
  });

  it("skips a patch whose name disagrees with its target, as the harness does", () => {
    const fx = fixture();
    writeBundle(fx, "fixture-bundle-base", [
      insertEntries(
        catalogEntry(["alpha-model"]),
        defaultRouteEntry("ollama", "delta-model"),
        policySettingsInsert(),
      ),
    ]);
    writeProfile(
      fx,
      ["fixture-bundle-base"],
      catalogEntry(["delta-model"], { name: "@deepseek-ai/dsh-not-the-catalog" }),
    );
    writeRole(fx, "fixer", `model: "${pinFor("delta-model")}"`);
    writeCatalog(fx, ["alpha-model", "delta-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    // The mismatched patch is skipped, so delta-model never joins the catalog —
    // even though the pin is the inherited route.
    expect(res.stdout).toContain(
      "✗ fixer: delta-model — NOT DECLARED, inherited route (no policy in force), served",
    );
  });

  it("resolves a bundle from the installation anchor before a profile-local copy", () => {
    const fx = fixture();
    const installCopy = [
      insertEntries(
        catalogEntry(["install-model"]),
        defaultRouteEntry("ollama", "install-model"),
        policySettingsInsert(),
      ),
    ];
    const profileCopy = [
      insertEntries(
        catalogEntry(["profile-model"]),
        defaultRouteEntry("ollama", "profile-model"),
        policySettingsInsert(),
      ),
    ];
    writeBundle(fx, "fixture-bundle-base", installCopy, { anchor: "install" });
    writeBundle(fx, "fixture-bundle-base", profileCopy, { anchor: "profile" });
    writeProfile(fx, ["fixture-bundle-base"]);
    writeRole(fx, "role", `model: "${pinFor("install-model")}"`);
    writeCatalog(fx, ["install-model", "profile-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("catalog 1 model id(s)");
    expect(res.stdout).toContain(
      "✓ role: install-model — declared, inherited route (no policy in force), served",
    );
  });
});

describe("catalog verdicts", () => {
  it("fails an undeclared pin and --fix declares it in the owning layer, behind a backup", () => {
    const fx = fixture();
    // The bundle ships alpha and beta and defaults to beta; the profile layer
    // replaced the catalog with alpha alone, dropping beta — the shallow
    // replacement that leaves the pin undeclared while its route still is the
    // inherited one.
    composeBase(fx, {
      declared: ["alpha-model", "beta-model"],
      model: "beta-model",
      profilePatch: catalogEntry(["alpha-model"]),
    });
    writeRole(fx, "reviewer", `model: "${pinFor("beta-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model"]);
    const patchFile = join(fx.profile, "cordis.patch.yml");
    const before = readFileSync(patchFile, "utf8");

    // The declaring run still exits non-zero — it reports the failure it just
    // fixed; the re-run is the confirmation.
    const first = runPreflight(fx, ["--fix"]);

    expect(first.status).toBe(1);
    expect(first.stdout).toContain(
      "✗ reviewer: beta-model — NOT DECLARED, inherited route (no policy in force), served",
    );
    expect(first.stdout).toContain(`+ declared beta-model in ${patchFile}`);
    const fixed = readFileSync(patchFile, "utf8");
    expect(fixed.match(/^\s*- id: beta-model$/gm)).toHaveLength(1);
    expect(fixed).not.toContain('"beta-model"');
    // The append lands at the models list's own dash indentation and keeps the
    // provider catalog shape.
    expect(fixed).toContain("          - id: beta-model\n            reasoningEfforts:");
    const parsed = parseEntries(fixed);
    expect(findEntry(parsed, "llm-pi-ai").config.providers.ollama.models.map((m) => m.id)).toEqual([
      "alpha-model",
      "beta-model",
    ]);
    const backups = backupsOf(patchFile);
    expect(backups).toHaveLength(1);
    expect(resolve(backups[0]).startsWith(resolve(fx.root))).toBe(true);
    expect(readFileSync(backups[0], "utf8")).toBe(before);

    const second = runPreflight(fx, ["--fix"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(
      "✓ reviewer: beta-model — declared, inherited route (no policy in force), served",
    );
    // A green re-run writes nothing: no second backup, no duplicate.
    expect(readFileSync(patchFile, "utf8")).toBe(fixed);
    expect(backupsOf(patchFile)).toHaveLength(1);
  });

  it("refuses to declare into an installed bundle layer", () => {
    const fx = fixture();
    const bundleDir = writeBundle(fx, "fixture-bundle-base", [
      insertEntries(
        catalogEntry(["alpha-model"]),
        defaultRouteEntry("ollama", "alpha-model"),
        policySettingsInsert(),
      ),
    ]);
    writeProfile(fx, ["fixture-bundle-base"]);
    writeRole(fx, "fixer", `model: "${pinFor("beta-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model"]);
    const bundleFile = join(bundleDir, "patch-0.yml");
    const before = readFileSync(bundleFile, "utf8");

    const res = runPreflight(fx, ["--fix"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain(
      `declare beta-model in your own patch layer ${join(fx.profile, "cordis.patch.yml")}`,
    );
    expect(res.stdout).toContain("never edits an installed bundle");
    expect(res.stdout).not.toContain("+ declared");
    expect(readFileSync(bundleFile, "utf8")).toBe(before);
    expect(existsSync(join(fx.profile, "cordis.patch.yml"))).toBe(false);
  });

  it("checks a concrete id with --check, declared and undeclared", () => {
    const fx = fixture();
    composeBase(fx, { profilePatch: catalogEntry(["alpha-model"]) });
    writeCatalog(fx, ["alpha-model"]);

    const declared = runPreflight(fx, ["--check", "alpha-model"]);
    expect(declared.status).toBe(0);
    expect(declared.stdout).toContain(
      "✓ (--check): alpha-model — declared, inherited route (no policy in force), served",
    );

    const undeclared = runPreflight(fx, ["--check", "ghost-model"]);
    expect(undeclared.status).toBe(1);
    expect(undeclared.stdout).toContain(
      "✗ (--check): ghost-model — NOT DECLARED, NOT the inherited route (no policy in force), NOT SERVED",
    );
  });
});

describe("route policy", () => {
  it("fails a declared pin an enabled policy omits, with the paste-safe entry", () => {
    const fx = fixture();
    composeBase(fx, {
      declared: ["alpha-model", "beta-model"],
      profilePatch:
        catalogEntry(["alpha-model", "beta-model"]) +
        policyEntry({ enabled: true, routes: ["ollama/alpha-model"] }),
    });
    writeRole(fx, "reviewer", `model: "${pinFor("beta-model")}"`);
    writeRole(fx, "implementer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model"]);
    const patchFile = join(fx.profile, "cordis.patch.yml");

    // --fix declares into the catalog; a narrowed route is an owner-side
    // settings edit, so --fix must leave the route list alone.
    const res = runPreflight(fx, ["--fix"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("✗ reviewer: beta-model — declared, NOT ALLOWED, served");
    expect(res.stdout).toContain("✓ implementer: alpha-model — declared, allowed, served");
    expect(res.stdout).toContain(
      `fix: add this route to subagent-model-selection-settings.allowedModels in ${patchFile} — never reroute the pin:`,
    );
    // The printed entry carries the file's own indentation, and pasting it
    // verbatim leaves the file parseable with the route allowed.
    const printed = printedEntry(res.stdout, "ollama", "beta-model");
    expect([printed.dash, printed.model]).toEqual([6, 8]);
    const pasted = pasteAndParse(patchFile, printed.block);
    expect(
      findEntry(pasted, "subagent-model-selection-settings").config.allowedModels,
    ).toContainEqual({ provider: "ollama", model: "beta-model" });
    expect(readFileSync(patchFile, "utf8")).not.toContain("model: beta-model");
    expect(backupsOf(patchFile)).toHaveLength(0);
  });

  it("exits 0 with the no-narrowing note when the settings entry carries no config", () => {
    const fx = fixture();
    composeBase(fx, { profilePatch: catalogEntry(["alpha-model"]) });
    writeRole(fx, "fixer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("− no narrowing in force:");
    expect(res.stdout).toContain(
      "`subagent-model-selection-settings` carries no config in the composed tree",
    );
    expect(res.stdout).toContain("its thoughtLevel is not named either");
    expect(res.stdout).toContain(
      "✓ fixer: alpha-model — declared, inherited route (no policy in force), served",
    );
  });

  it("exits 0 with the same note when the policy is present and enabled: false", () => {
    const fx = fixture();
    composeBase(fx, {
      profilePatch: catalogEntry(["alpha-model"]) + policyEntry({ enabled: false }),
    });
    writeRole(fx, "fixer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("− no narrowing in force:");
    expect(res.stdout).toContain("is present but not enabled");
  });

  it("exits 0 with the note naming the entry when no layer carries it", () => {
    const fx = fixture();
    composeBase(fx, { policySettings: false, profilePatch: catalogEntry(["alpha-model"]) });
    writeRole(fx, "fixer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("− no narrowing in force:");
    expect(res.stdout).toContain(
      "no `subagent-model-selection-settings` entry in the composed tree",
    );
  });

  it("fails a declared pin that is not the inherited route, with the owner-side policy block", () => {
    const fx = fixture();
    composeBase(fx, { declared: ["alpha-model", "beta-model"], model: "alpha-model" });
    writeRole(fx, "senior-implementer", `model: "${pinFor("beta-model")}"`);
    writeCatalog(fx, ["alpha-model", "beta-model"]);
    const patchFile = join(fx.profile, "cordis.patch.yml");

    const res = runPreflight(fx, ["--fix"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain(
      "✗ senior-implementer: beta-model — declared, NOT the inherited route (no policy in force), served",
    );
    expect(res.stdout).toContain(
      `enable the policy in ${patchFile} with every declared catalog id (it is a narrowing guard, not a filter), never reroute the pin (the pin truth is the role file's)`,
    );
    // The block enables the policy with every declared catalog id, and says the
    // effort naming comes back with it.
    expect(res.stdout).toContain("- id: subagent-model-selection-settings");
    expect(res.stdout).toContain("    enabled: true");
    expect(res.stdout).toContain("        model: alpha-model");
    expect(res.stdout).toContain("        model: beta-model");
    expect(res.stdout).toContain("enabling also lets a dispatch name the pin's thoughtLevel again");
    // A policy edit is owner-side: --fix wrote nothing.
    expect(existsSync(patchFile)).toBe(false);
    expect(readdirSync(fx.profile)).toEqual(["package.json"]);
  });

  it("names every layer it searched when no composed default route exists", () => {
    const fx = fixture();
    const bundleDir = writeBundle(fx, "fixture-bundle-base", [
      insertEntries(catalogEntry(["alpha-model"]), policySettingsInsert()),
    ]);
    writeProfile(fx, ["fixture-bundle-base"], catalogEntry(["alpha-model"]));
    writeRole(fx, "fixer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain(
      "✗ fixer: alpha-model — declared, no inherited route to resolve to (no policy in force), served",
    );
    expect(res.stdout).toContain(
      "no composed agent-default-model route in the 2 layer(s) searched:",
    );
    expect(res.stdout).toContain(join(bundleDir, "patch-0.yml"));
    expect(res.stdout).toContain(join(fx.profile, "cordis.patch.yml"));
  });
});

describe("unreadable config", () => {
  it("exits 1 naming every path it looked in when no composed config exists", () => {
    const fx = fixture();

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("looked in:");
    for (const path of [
      join(fx.profile, "package.json"),
      join(fx.profile, "cordis.patch.yml"),
      join(fx.home, "cordis.patch.yml"),
      join(fx.install, "package.json"),
    ])
      expect(res.stderr).toContain(path);
    expect(res.out).not.toContain("is DSH installed on this machine");
  });

  it("is fatal on a bundle it cannot resolve, naming the bundle and both anchors", () => {
    const fx = fixture();
    writeProfile(fx, ["fixture-missing-bundle"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('cannot resolve the profile bundle "fixture-missing-bundle"');
    expect(res.stderr).toContain(join(fx.install, "package.json"));
    expect(res.stderr).toContain(fx.profile);
  });

  it("is fatal on a bundle whose declared patch file is absent", () => {
    const fx = fixture();
    const dir = writeBundle(fx, "fixture-bundle-base", [catalogEntry(["alpha-model"])]);
    rmSync(join(dir, "patch-0.yml"));
    writeProfile(fx, ["fixture-bundle-base"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain(join(dir, "patch-0.yml"));
  });
});

describe("stale sources", () => {
  it("never takes a verdict from a stale settings backup or an imported document", () => {
    const fx = fixture();
    composeBase(fx, { profilePatch: catalogEntry(["alpha-model"]) });
    writeRole(fx, "fixer", `model: "${pinFor("ghost-model")}"`);
    writeCatalog(fx, ["alpha-model", "ghost-model"]);
    // Files that would declare ghost-model and allow its route if they were
    // read: the imported legacy document and two stale backups. The composed
    // tree declares only alpha-model and has no policy in force.
    const stale =
      catalogEntry(["ghost-model"]) +
      policyEntry({ enabled: true, routes: ["ollama/ghost-model"] });
    writeFileSync(join(fx.home, "settings.yaml.imported"), stale);
    writeFileSync(join(fx.home, "cordis.patch.yml.bak-20260101-000000"), stale);
    writeFileSync(join(fx.profile, "cordis.patch.yml.bak-20260101-000000"), stale);
    const before = [
      join(fx.home, "settings.yaml.imported"),
      join(fx.home, "cordis.patch.yml.bak-20260101-000000"),
      join(fx.profile, "cordis.patch.yml.bak-20260101-000000"),
    ].map((file) => readFileSync(file, "utf8"));

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain(
      "✗ fixer: ghost-model — NOT DECLARED, NOT the inherited route (no policy in force), served",
    );
    expect(res.stdout).toContain("catalog 1 model id(s)");
    expect(res.stdout).toContain("policy not in force");
    // The stale files are neither read nor written.
    for (const [i, file] of [
      join(fx.home, "settings.yaml.imported"),
      join(fx.home, "cordis.patch.yml.bak-20260101-000000"),
      join(fx.profile, "cordis.patch.yml.bak-20260101-000000"),
    ].entries())
      expect(readFileSync(file, "utf8")).toBe(before[i]);
  });
});

describe("pin shapes", () => {
  it("resolves a quoted pin, a bare pin and the custom-encoded shape to the same model id", () => {
    const fx = fixture();
    writeRole(fx, "fixer", `model: "${PIN_SLASH}"\nthoughtLevel: max`);
    writeRole(fx, "implementer", `model: "${PIN_CUSTOM}"\nthoughtLevel: max`);
    writeRole(fx, "senior-implementer", `model: ${PIN_SLASH}\nthoughtLevel: max`);
    composeBase(fx, {
      declared: ["deepseek-v4.1-flash"],
      profilePatch:
        catalogEntry(["deepseek-v4.1-flash"]) +
        policyEntry({ enabled: true, routes: ["ollama/deepseek-v4.1-flash"] }),
    });
    writeCatalog(fx, ["deepseek-v4.1-flash"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    for (const role of ["fixer", "implementer", "senior-implementer"])
      expect(res.stdout).toContain(`✓ ${role}: deepseek-v4.1-flash — declared, allowed, served`);
    expect(res.stdout).toContain("✓ all 3 checked pin(s) resolve on DSH");
  });

  it("notes inherit and pin-less roles without checking them", () => {
    const fx = fixture();
    writeRole(fx, "fixer", "model: inherit\nthoughtLevel: max");
    writeRole(fx, "reviewer", "thoughtLevel: max");
    writeRole(fx, "implementer", `model: "${pinFor("alpha-model")}"`);
    composeBase(fx, { profilePatch: catalogEntry(["alpha-model"]) });
    writeCatalog(fx, ["alpha-model"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("− fixer: inherit");
    expect(res.stdout).toContain("− reviewer: no pin");
    expect(res.stdout).toContain("✓ all 1 checked pin(s) resolve on DSH");
  });
});

describe("--fix argument guard", () => {
  it("rejects a quoted or routed --check id instead of writing it", () => {
    const fx = fixture();
    composeBase(fx, { profilePatch: catalogEntry(["alpha-model"]) });
    writeRole(fx, "fixer", `model: "${pinFor("alpha-model")}"`);
    writeCatalog(fx, ["alpha-model"]);
    const patchFile = join(fx.profile, "cordis.patch.yml");
    const before = readFileSync(patchFile, "utf8");

    const quoted = runPreflight(fx, ["--fix", "--check", '"beta-model"']);
    expect(quoted.status).toBe(1);
    expect(quoted.out).toContain("is not a bare model id");

    const routed = runPreflight(fx, ["--fix", "--check", "ollama/beta-model"]);
    expect(routed.status).toBe(1);
    expect(routed.out).toContain("is not a bare model id");

    expect(readFileSync(patchFile, "utf8")).toBe(before);
    expect(backupsOf(patchFile)).toHaveLength(0);
  });
});
