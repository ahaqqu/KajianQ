import { afterAll, describe, expect, it } from "vitest";
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
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * `bun run dsh:preflight` — the role-pin resolution gate (#222).
 *
 * Four parts of the gate's contract are pinned here, each against fixtures
 * rather than this machine:
 *
 * - a pin resolves to its model id whatever the ZCode editor wrote — quoted
 *   or bare, `<uuid>/<id>:cloud` or `custom:<uuid>:<id>%3Acloud` (the
 *   after-the-last-`/` recipe cannot read the second shape);
 * - a pin whose id is declared but whose route is absent from
 *   `subagent-model-selection.allowedModels` FAILS, with the exact settings
 *   edit printed at the file's own indentation, so it is paste-safe — the
 *   narrowing guard. The list carries every declared catalog id today, so the
 *   guard rejects nothing now; the test is what keeps it load-bearing for a
 *   future narrowing;
 * - `--fix` appends a bare, de-duplicated declaration, backing up the original
 *   first, and only ever against the settings path under test;
 * - the three seams are all-or-nothing: a run that redirects the read paths
 *   without the settings path is refused, never pointed at the real file.
 *
 * Every run goes through `runPreflight`, which sets all three machine-global
 * seams (`DSH_PIN_CHECK_SETTINGS`, `DSH_PIN_CHECK_ROLES_DIR`,
 * `DSH_PIN_CHECK_CATALOG`) and refuses a settings path outside the fixture.
 * That is the second layer of the safety boundary; the first is the script's
 * own all-or-nothing guard, which refuses a run that redirects the read paths
 * while leaving the write path real (`--fix` included). The suite then proves
 * the boundary from both directions: the real file is re-read and compared
 * byte for byte when it existed at module load, and asserted still absent when
 * it did not — so a run that created it fails here too.
 */

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/dsh-pin-check.mjs");
const REAL_SETTINGS = join(homedir(), ".dsh", "settings.yaml");
const realSettingsBefore = existsSync(REAL_SETTINGS) ? readFileSync(REAL_SETTINGS, "utf8") : null;

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  if (realSettingsBefore !== null)
    expect(readFileSync(REAL_SETTINGS, "utf8")).toBe(realSettingsBefore);
  else expect(existsSync(REAL_SETTINGS)).toBe(false);
});

const PIN_SLASH = "d5585e04-940a-41f6-a9ec-320bb4fccd7e/deepseek-v4.1-flash:cloud";
const PIN_CUSTOM = "custom:d5585e04-940a-41f6-a9ec-320bb4fccd7e:deepseek-v4.1-flash%3Acloud";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-pin-check-"));
  roots.push(root);
  const fx = {
    root,
    roles: join(root, "agents"),
    settings: join(root, "settings.yaml"),
    catalog: join(root, "catalog.json"),
  };
  mkdirSync(fx.roles, { recursive: true });
  return fx;
}

function writeRole(fx, role, frontmatter) {
  writeFileSync(join(fx.roles, `${role}.md`), `---\n${frontmatter}\n---\n\nRole body.\n`);
}

function writeCatalog(fx, ids) {
  writeFileSync(fx.catalog, `${JSON.stringify({ data: ids.map((id) => ({ id })) }, null, 2)}\n`);
}

function writeSettingsText(fx, text) {
  writeFileSync(fx.settings, text);
}

/** A settings fixture in the real file's shape: a provider catalog, then the
 * route policy. `allowed` entries are `provider/model` routes. */
function writeSettings(fx, { declared, allowed, enabled = true }) {
  const models = declared
    .map(
      (id) =>
        `        - id: ${id}\n          reasoningEfforts:\n            off: none\n            high: high`,
    )
    .join("\n");
  const routes = allowed
    .map((route) => {
      const [provider, model] = route.split("/");
      return `    - provider: ${provider}\n      model: ${model}`;
    })
    .join("\n");
  writeSettingsText(
    fx,
    `llm-pi-ai:
  providers:
    ollama:
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-completions
      baseURL: https://ollama.com/v1
      models:
${models}
agent-default-model:
  provider: ollama
  model: ${declared[0]}
  reasoningEffort: max
subagent-model-selection:
  enabled: ${enabled}
  allowedModels:
${routes}
`,
  );
}

function runPreflight(fx, args = []) {
  expect(resolve(fx.settings).startsWith(resolve(fx.root))).toBe(true);
  expect(resolve(fx.settings)).not.toBe(resolve(REAL_SETTINGS));
  const res = spawnSync("bun", [SCRIPT, ...args], {
    env: {
      ...process.env,
      DSH_PIN_CHECK_SETTINGS: fx.settings,
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

/** The printed fix block, as it appears in stdout: its two lines with their
 * own indentation, ready to be pasted into `allowedModels`. */
function printedEntry(stdout, provider, model) {
  const m = stdout.match(new RegExp(`^( *)- provider: ${provider}\\n( *)model: ${model}$`, "m"));
  if (!m) throw new Error(`no printed ${provider}/${model} entry in:\n${stdout}`);
  return { block: m[0], dash: m[1].length, model: m[2].length };
}

/** Paste a printed block verbatim at the end of the fixture's `allowedModels`
 * list — the operator's paste — and parse the result with a real YAML parser
 * (Bun's). The gate's contract is that the printed entry is paste-safe as
 * printed: at the wrong depth the file stops parsing, which would take the
 * whole harness config down with it. */
function pasteAndParse(fx, block) {
  const pasted = join(fx.root, "pasted.yaml");
  writeFileSync(pasted, `${readFileSync(fx.settings, "utf8")}${block}\n`);
  return spawnSync(
    "bun",
    [
      "-e",
      'const text = require("node:fs").readFileSync(0, "utf8");const doc = Bun.YAML.parse(text);console.log(JSON.stringify(doc["subagent-model-selection"].allowedModels));',
    ],
    { input: readFileSync(pasted, "utf8"), encoding: "utf8" },
  );
}

const backupsIn = (fx) => readdirSync(fx.root).filter((f) => f.startsWith("settings.yaml.bak-"));

describe("test seams", () => {
  it("refuses a partial seam redirection instead of falling through to the real settings file", () => {
    const fx = fixture();
    writeRole(fx, "reviewer", `model: "${PIN_SLASH}"`);
    writeCatalog(fx, ["deepseek-v4.1-flash"]);
    // HOME is redirected as well, so this test is safe to run even when it is
    // red: without the guard the script would read (and with --fix write) the
    // empty temp-home path, never the owner's real file.
    const fakeHome = join(fx.root, "home");
    mkdirSync(fakeHome, { recursive: true });
    const baseEnv = { ...process.env, HOME: fakeHome };
    for (const seam of [
      "DSH_PIN_CHECK_SETTINGS",
      "DSH_PIN_CHECK_ROLES_DIR",
      "DSH_PIN_CHECK_CATALOG",
    ])
      delete baseEnv[seam];

    for (const [seam, value] of [
      ["DSH_PIN_CHECK_ROLES_DIR", fx.roles],
      ["DSH_PIN_CHECK_CATALOG", fx.catalog],
    ]) {
      const res = spawnSync("bun", [SCRIPT, "--fix"], {
        env: { ...baseEnv, [seam]: value },
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${seam} is set without DSH_PIN_CHECK_SETTINGS`);
      expect(res.stdout).not.toContain("+ declared");
    }
    expect(existsSync(join(fakeHome, ".dsh"))).toBe(false);
  });
});

describe("pin shapes", () => {
  it("resolves a quoted pin, a bare pin and the custom-encoded shape to the same model id", () => {
    const fx = fixture();
    writeRole(fx, "fixer", `model: "${PIN_SLASH}"\nthoughtLevel: max`);
    writeRole(fx, "implementer", `model: "${PIN_CUSTOM}"\nthoughtLevel: max`);
    writeRole(fx, "senior-implementer", `model: ${PIN_SLASH}\nthoughtLevel: max`);
    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash"],
      allowed: ["ollama/deepseek-v4.1-flash"],
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
    writeRole(fx, "implementer", `model: "${PIN_SLASH}"`);
    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash"],
      allowed: ["ollama/deepseek-v4.1-flash"],
    });
    writeCatalog(fx, ["deepseek-v4.1-flash"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("− fixer: inherit");
    expect(res.stdout).toContain("− reviewer: no pin");
    expect(res.stdout).toContain("✓ all 1 checked pin(s) resolve on DSH");
  });
});

describe("subagent route narrowing guard", () => {
  it("fails a declared pin whose route is absent from allowedModels, with the exact settings edit", () => {
    const fx = fixture();
    writeRole(fx, "reviewer", `model: "d5585e04-940a-41f6-a9ec-320bb4fccd7e/kimi-k3:cloud"`);
    writeRole(fx, "implementer", `model: "${PIN_SLASH}"`);
    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash", "kimi-k3"],
      allowed: ["ollama/deepseek-v4.1-flash"],
    });
    writeCatalog(fx, ["deepseek-v4.1-flash", "kimi-k3"]);

    // --fix declares into the catalog; a narrowed route is an owner-side
    // settings edit, so --fix must leave the route list alone.
    const res = runPreflight(fx, ["--fix"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("✗ reviewer: kimi-k3 — declared, NOT ALLOWED, served");
    expect(res.stdout).toContain("✓ implementer: deepseek-v4.1-flash — declared, allowed, served");
    expect(res.stdout).toContain(
      `fix: add this route to subagent-model-selection.allowedModels in ${fx.settings} — never reroute the pin:`,
    );
    // The printed entry carries the file's own indentation (4/6, as the real
    // file does), and pasting it verbatim leaves the file parseable.
    const printed = printedEntry(res.stdout, "ollama", "kimi-k3");
    const existing = readFileSync(fx.settings, "utf8").match(
      /^( *)- provider: ollama\n( *)model: deepseek/m,
    );
    expect([printed.dash, printed.model]).toEqual([existing[1].length, existing[2].length]);
    expect([printed.dash, printed.model]).toEqual([4, 6]);
    const pasted = pasteAndParse(fx, printed.block);
    expect(pasted.status).toBe(0);
    expect(JSON.parse(pasted.stdout)).toContainEqual({ provider: "ollama", model: "kimi-k3" });
    const settings = readFileSync(fx.settings, "utf8");
    expect(settings).toContain(
      "allowedModels:\n    - provider: ollama\n      model: deepseek-v4.1-flash\n",
    );
    expect(settings).not.toContain("model: kimi-k3");
    expect(backupsIn(fx)).toHaveLength(0);
  });

  it("prints the file's indentation when allowedModels is empty too", () => {
    const fx = fixture();
    writeRole(fx, "fixer", `model: "${PIN_SLASH}"`);
    writeSettings(fx, { declared: ["deepseek-v4.1-flash"], allowed: [] });
    writeCatalog(fx, ["deepseek-v4.1-flash"]);

    const res = runPreflight(fx);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("✗ fixer: deepseek-v4.1-flash — declared, NOT ALLOWED, served");
    const printed = printedEntry(res.stdout, "ollama", "deepseek-v4.1-flash");
    expect([printed.dash, printed.model]).toEqual([4, 6]);
    const pasted = pasteAndParse(fx, printed.block);
    expect(pasted.status).toBe(0);
    expect(JSON.parse(pasted.stdout)).toContainEqual({
      provider: "ollama",
      model: "deepseek-v4.1-flash",
    });
  });

  it("fails when the policy block is absent or disabled — no pin can be dispatched by route", () => {
    const fx = fixture();
    writeRole(fx, "fixer", `model: "${PIN_SLASH}"`);
    writeCatalog(fx, ["deepseek-v4.1-flash"]);
    writeSettingsText(
      fx,
      "llm-pi-ai:\n  providers:\n    ollama:\n      models:\n        - id: deepseek-v4.1-flash\n",
    );

    const absent = runPreflight(fx);
    expect(absent.status).toBe(1);
    expect(absent.out).toContain(`no "subagent-model-selection:" block in ${fx.settings}`);

    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash"],
      allowed: ["ollama/deepseek-v4.1-flash"],
      enabled: false,
    });
    const disabled = runPreflight(fx);
    expect(disabled.status).toBe(1);
    expect(disabled.out).toContain(`"subagent-model-selection:" is not enabled in ${fx.settings}`);
  });
});

describe("--fix", () => {
  it("appends a bare declaration once, backs up the original, and never writes a duplicate", () => {
    const fx = fixture();
    writeRole(fx, "reviewer", `model: "d5585e04-940a-41f6-a9ec-320bb4fccd7e/kimi-k3:cloud"`);
    writeRole(fx, "implementer", `model: "${PIN_SLASH}"`);
    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash"],
      allowed: ["ollama/deepseek-v4.1-flash", "ollama/kimi-k3"],
    });
    writeCatalog(fx, ["deepseek-v4.1-flash", "kimi-k3"]);
    const before = readFileSync(fx.settings, "utf8");

    // The declaring run still exits non-zero — it reports the failure it just
    // fixed; the re-run is the confirmation.
    const first = runPreflight(fx, ["--fix"]);
    expect(first.status).toBe(1);
    expect(first.stdout).toContain("+ declared kimi-k3 in");

    const fixed = readFileSync(fx.settings, "utf8");
    expect(fixed.match(/^\s*- id: kimi-k3$/gm)).toHaveLength(1);
    expect(fixed).not.toContain('"kimi-k3"');
    expect(fixed.match(/- id:/g)).toHaveLength(2);
    const backups = backupsIn(fx);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fx.root, backups[0]), "utf8")).toBe(before);

    const second = runPreflight(fx, ["--fix"]);
    expect(second.status).toBe(0);
    expect(readFileSync(fx.settings, "utf8")).toBe(fixed);
    expect(backupsIn(fx)).toHaveLength(1);
  });

  it("rejects a quoted or routed --check id instead of writing it", () => {
    const fx = fixture();
    writeRole(fx, "fixer", `model: "${PIN_SLASH}"`);
    writeSettings(fx, {
      declared: ["deepseek-v4.1-flash"],
      allowed: ["ollama/deepseek-v4.1-flash"],
    });
    writeCatalog(fx, ["deepseek-v4.1-flash"]);
    const before = readFileSync(fx.settings, "utf8");

    const quoted = runPreflight(fx, ["--fix", "--check", '"kimi-k3"']);
    expect(quoted.status).toBe(1);
    expect(quoted.out).toContain("is not a bare model id");

    const routed = runPreflight(fx, ["--fix", "--check", "ollama/kimi-k3"]);
    expect(routed.status).toBe(1);
    expect(routed.out).toContain("is not a bare model id");

    expect(readFileSync(fx.settings, "utf8")).toBe(before);
    expect(backupsIn(fx)).toHaveLength(0);
  });
});
