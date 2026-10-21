import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

/**
 * The deploy's provisioned-artifact preflight: every file apply.sh places must
 * match the checkout the deploy runs from, or the deploy refuses the box and
 * names the file to apply.
 *
 * The artifact set is derived from apply.sh's own table (`--list-artifacts`),
 * so these tests drive the two shipped halves — the manifest emitter and the
 * box-side checker — against a fixture tree; no VPS, no root, no ssh.
 */

const REPO = process.cwd();
const DRIFT = resolve(REPO, "provision/vps/deploy/provision-drift.sh");
const APPLY = resolve(REPO, "provision/vps/apply.sh");
const DEPLOY = resolve(REPO, "provision/vps/deploy/deploy.sh");
const read = (rel) => readFileSync(resolve(REPO, rel), "utf8");

/**
 * Every artifact apply.sh places, including the sites-enabled link. A new row in
 * its table must be added here too — the count is the coverage check for "every
 * artifact the deploy depends on".
 */
const PROVISIONED_ARTIFACTS = 13;

/** The 12-character digest the drift refusal prints, computed independently. */
const digest12 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** How many times a line appears, for "exactly one count line" assertions. */
const countOf = (text, needle) => text.split(needle).length - 1;

/** The count line's apply-clearable form, with its total. */
const mismatchCount = (failures, total = PROVISIONED_ARTIFACTS) =>
  `${failures} of ${total} provisioned artifact(s) do not match the checkout`;

/** The count line's form when any refusal is one an apply cannot clear. */
const manualCount = (failures, total = PROVISIONED_ARTIFACTS) =>
  `${failures} of ${total} provisioned artifact(s) could not be compared or do not match the checkout`;

const OWNER = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
const GROUP = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();

function sh(program, args, options = {}) {
  return spawnSync(program, args, { encoding: "utf8", ...options });
}

/** The rows `apply.sh --list-artifacts` prints, parsed. */
function artifacts() {
  const result = sh("bash", [APPLY, "--list-artifacts"]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, kind, src, dst, owner, group, mode] = line.split("|");
      return { name, kind, src, dst, owner, group, mode };
    });
}

/** The manifest the deploy ships to the box, emitted from the real checkout. */
function emitManifest(checkout = REPO) {
  const result = sh("bash", [DRIFT, "--emit-manifest", checkout]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/**
 * The manifest's owner/group are the box's root:root (what apply.sh installs).
 * A fixture tree cannot be root-owned, so the tests substitute their own
 * identity; the production expectation is pinned by the enumeration test.
 */
function fixtureManifest(manifest) {
  return manifest.replaceAll("|root|root|", `|${OWNER}|${GROUP}|`);
}

const RENDER_VALUES = {
  __KAJIANQ_DOMAIN__: "kajianq.example.test",
  __KAJIANQ_TLS_CERT__: "/etc/letsencrypt/live/kajianq.example.test/fullchain.pem",
  __KAJIANQ_TLS_KEY__: "/etc/letsencrypt/live/kajianq.example.test/privkey.pem",
  __KAJIANQ_API_UPSTREAM__: "http://127.0.0.1:8787",
};

/** A shipped template with the placeholders a box's proxy.env would substitute. */
function renderTemplate(text, overrides = {}) {
  return Object.entries({ ...RENDER_VALUES, ...overrides }).reduce(
    (rendered, [token, value]) => rendered.split(token).join(value),
    text,
  );
}

/** A fixture box: every artifact installed from the checkout, at its real mode. */
function driftFixture({ without = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-drift-"));
  const rows = artifacts();
  const template = (row) => read(join("provision/vps", row.src));
  const path = (dst) => join(dir, dst.replace(/^\//, "").replace("*", "16"));
  const install = (row) => {
    const installed = path(row.dst);
    mkdirSync(dirname(installed), { recursive: true });
    if (row.kind === "link") {
      rmSync(installed, { force: true });
      symlinkSync(path(row.src), installed);
      return;
    }
    writeFileSync(installed, row.kind === "render" ? renderTemplate(template(row)) : template(row));
    chmodSync(installed, parseInt(row.mode, 8));
  };
  // Files first, then links: a link's target must exist when it is created, as
  // it does on a box where apply.sh installs the block before enabling it.
  for (const row of rows) {
    if (row.kind !== "link" && !without.includes(row.name)) install(row);
  }
  for (const row of rows) {
    if (row.kind === "link" && !without.includes(row.name)) install(row);
  }
  const manifest = fixtureManifest(emitManifest());
  return {
    dir,
    rows,
    manifest,
    path,
    install,
    check: ({ manifest: given = manifest, base64 = false, env } = {}) =>
      base64
        ? sh("bash", [
            DRIFT,
            "--check",
            "--root",
            dir,
            "--manifest-base64",
            Buffer.from(given).toString("base64"),
          ])
        : sh("bash", [DRIFT, "--check", "--root", dir], {
            input: given,
            ...(env ? { env: { ...process.env, ...env } } : {}),
          }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The `render_matches` function as provision-drift.sh defines it. */
function renderMatchesSource() {
  const body = /^render_matches\(\) \{\n[\s\S]*?^\}\n/m.exec(
    read("provision/vps/deploy/provision-drift.sh"),
  )?.[0];
  expect(body, "provision-drift.sh must define render_matches()").toBeTruthy();
  return body;
}

/** Run the shipped provenance gate against a fixture unit and record. */
function provenance(unit, record) {
  return sh("bash", [resolve(REPO, "provision/vps/deploy/backup-provenance.sh"), unit, record]);
}

/** apply.sh with its deploy-grant mode cell rewritten, for a table-load probe. */
function applyWithMode(mode) {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-apply-mode-"));
  const copy = join(dir, "apply.sh");
  writeFileSync(
    copy,
    read("provision/vps/apply.sh").replace("|root|root|440", `|root|root|${mode}`),
  );
  return { dir, copy };
}

/**
 * A checkout whose apply.sh table is rewritten, for the shapes a future
 * destination would trip. The real source tree is linked in, so the shipped
 * manifest emitter hashes the shipped files.
 */
function checkoutWithTable(rewrite) {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-table-"));
  const source = join(dir, "provision/vps");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "apply.sh"), rewrite(read("provision/vps/apply.sh")));
  for (const entry of [
    "backup",
    "journald",
    "logrotate",
    "nginx",
    "postgres",
    "sudoers",
    "systemd",
  ]) {
    symlinkSync(resolve(REPO, "provision/vps", entry), join(source, entry));
  }
  return { checkout: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A checkout whose apply.sh table carries one extra row (the shape probe). */
function checkoutWithExtraRow(row) {
  return checkoutWithTable((table) => table.replace("deploy-grant|", `${row}\ndeploy-grant|`));
}

describe("the artifact set is enumerated from apply.sh itself", () => {
  it("lists every artifact apply.sh places, with its destination, owner and mode", () => {
    const rows = artifacts();
    expect(rows.length, "every provisioned artifact must be listed").toBe(PROVISIONED_ARTIFACTS);
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const row of rows) {
      expect(row.kind, row.name).toMatch(/^(config|render|sudoers|link)$/);
      expect(row.dst, row.name).toMatch(/^\//);
      expect(row.owner, row.name).toBe("root");
      expect(row.group, row.name).toBe("root");
      if (row.kind === "link") {
        // A link row's source is its absolute target, and the target must be
        // another row's destination: a link to a path the table does not place
        // is a dangling promise, not an artifact.
        expect(
          [...byName.values()].some((other) => other.dst === row.src),
          row.name,
        ).toBe(true);
      } else {
        expect(() => statSync(resolve(REPO, "provision/vps", row.src)), row.src).not.toThrow();
      }
    }
    // The artifacts the deploy's own verdict reads: the units it restarts, the
    // marker the backup unit's ExecStartPre runs, the grant its sudo calls need.
    expect(byName.get("backup-unit").dst).toBe("/etc/systemd/system/kajianq-backup.service");
    expect(byName.get("api-unit").dst).toBe("/etc/systemd/system/kajianq-api.service");
    expect(byName.get("backup-marker").dst).toBe("/usr/local/sbin/kajianq-backup-pending");
    expect(byName.get("backup-marker").mode).toBe("755");
    expect(byName.get("deploy-grant").mode).toBe("440");
    expect(byName.get("nginx-conf").kind).toBe("render");
    // The enabled site is the link nginx resolves, so it is provisioned state in
    // its own right: a retargeted or deleted link leaves the box serving a block
    // this checkout does not describe.
    expect(byName.get("nginx-enabled").kind).toBe("link");
    expect(byName.get("nginx-enabled").src).toBe(byName.get("nginx-conf").dst);
    expect(byName.get("nginx-enabled").dst).toBe("/etc/nginx/sites-enabled/kajianq.conf");
    expect(byName.get("postgres").dst).toBe("/etc/postgresql/*/main/conf.d/99-kajianq.conf");
  });

  it("carries one versioned destination, and the checker keys its skip to that row", () => {
    // The zero-conf.d skip is the one apply.sh implements, for its Postgres row
    // only; every other row's destination reaches install literally. The
    // checker's skip row must name this row, so a new versioned row cannot slip
    // into the skip just by carrying a glob.
    const versioned = artifacts().filter((row) => dirname(row.dst).includes("*"));
    expect(versioned.map((row) => row.name)).toEqual(["postgres"]);
    const checker = read("provision/vps/deploy/provision-drift.sh");
    const skipRow = /^VERSIONED_SKIP_ROW="([^"]+)"/m.exec(checker)?.[1];
    expect(skipRow, "provision-drift.sh must name the row apply.sh resolves").toBe(
      versioned[0].name,
    );
  });

  it("has one install site per row and no install that bypasses the table", () => {
    const apply = read("provision/vps/apply.sh");
    const calls = [...apply.matchAll(/^\s*install_artifact (\S+)/gm)].map((match) => match[1]);
    expect(new Set(calls)).toEqual(new Set(artifacts().map((row) => row.name)));
    expect(calls.length).toBe(PROVISIONED_ARTIFACTS);
    // A direct install would place a file the drift check never hears about.
    expect(apply).not.toMatch(/^(run )?install_config "\$\{SRC\}/m);
    expect(apply).not.toMatch(/^render "\$\{SRC\}/m);
    // The same rule for the enabled site: the one `ln` is the helper the table's
    // `link` row calls, not a placement in the install section.
    const linkBody = /install_link\(\) \{[\s\S]*?\n\}/.exec(apply)?.[0];
    expect(linkBody, "apply.sh must install the link through install_link()").toBeTruthy();
    expect(linkBody).toMatch(/ln -sfn/);
    expect(apply.replace(linkBody, "")).not.toMatch(/^\s*(run )?ln /m);
  });

  it("needs no root and no env file to print the list", () => {
    const result = sh("bash", [APPLY, "--list-artifacts"], {
      env: { ...process.env, KAJIANQ_DOMAIN: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("must run as root");
    expect(result.stdout.trim().split("\n")).toHaveLength(PROVISIONED_ARTIFACTS);
  });

  it("keeps the deploy grant's row on the account the grant names", () => {
    const apply = read("provision/vps/apply.sh");
    const user = /^DEPLOY_USER="([^"]+)"/m.exec(apply)?.[1];
    expect(user, "apply.sh must bind DEPLOY_USER").toBeTruthy();
    const grant = artifacts().find((row) => row.name === "deploy-grant");
    expect(grant.dst).toBe(`/etc/sudoers.d/${user}`);
  });

  it("rejects a mode cell with a leading zero before it can install or be demanded", () => {
    // `install -m 0440` installs 0440 while `stat -c %a` prints 440. A cell
    // written that way would install one mode and the drift check would demand
    // another forever, so the table refuses it at load, before any install.
    const { dir, copy } = applyWithMode("0440");
    try {
      const result = sh("bash", [copy, "--list-artifacts"]);
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("deploy-grant");
      expect(result.stderr).toContain("0440");
      expect(result.stderr).toContain("no leading zero");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a mode cell that is not octal", () => {
    const { dir, copy } = applyWithMode("44o");
    try {
      const result = sh("bash", [copy, "--list-artifacts"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("44o");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the drift preflight", () => {
  it("passes over a box that holds the checkout's artifacts", () => {
    const fixture = driftFixture();
    try {
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `deploy: provisioned artifacts match the checkout (${PROVISIONED_ARTIFACTS})`,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses the stale-unit state the provenance gate reads as healthy (the red state)", () => {
    // The measured failure: the installed backup unit predates its current
    // definition, the durable record says the last run exited 0 after that
    // install, and the provenance gate alone prints healthy over the stale unit.
    // The drift preflight must refuse it first, naming the unit and the remedy.
    const fixture = driftFixture();
    try {
      const unit = fixture.path("/etc/systemd/system/kajianq-backup.service");
      writeFileSync(unit, readFileSync(unit, "utf8").replace(/^ExecStartPre=.*\n/m, ""));
      utimesSync(unit, 2000, 2000);
      const record = join(fixture.dir, "backup-provenance");
      writeFileSync(record, "status=0\nstarted_at=1000\ncompleted_at=3000\nlabel=stale\n");

      const oldGate = provenance(unit, record);
      expect(oldGate.status, oldGate.stderr).toBe(0);
      expect(oldGate.stdout).toContain("backup unit healthy");

      const drift = fixture.check();
      expect(drift.status).toBe(1);
      expect(drift.stderr).toContain("/etc/systemd/system/kajianq-backup.service");
      expect(drift.stderr).toContain("provision/vps/systemd/kajianq-backup.service");
      expect(drift.stderr).toContain("run provision/vps/apply.sh");
      expect(drift.stderr).toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed, then deploy again",
      );
      expect(drift.stderr).toContain(mismatchCount(1));
      expect(drift.stderr).not.toContain("could not be compared");
    } finally {
      fixture.cleanup();
    }
  });

  const MUTATIONS = [
    {
      case: "a unit whose definition changed",
      artifact: "/etc/systemd/system/kajianq-backup.service",
      source: "provision/vps/systemd/kajianq-backup.service",
      mutate: (fixture) => {
        const unit = fixture.path("/etc/systemd/system/kajianq-backup.service");
        writeFileSync(unit, readFileSync(unit, "utf8").replace(/^ExecStartPre=.*\n/m, ""));
      },
    },
    {
      case: "the ExecStartPre marker deleted",
      artifact: "/usr/local/sbin/kajianq-backup-pending",
      source: "provision/vps/backup/kajianq-backup-pending.sh",
      mutate: (fixture) => rmSync(fixture.path("/usr/local/sbin/kajianq-backup-pending")),
    },
    {
      case: "the marker no longer executable",
      artifact: "/usr/local/sbin/kajianq-backup-pending",
      source: "provision/vps/backup/kajianq-backup-pending.sh",
      mutate: (fixture) => chmodSync(fixture.path("/usr/local/sbin/kajianq-backup-pending"), 0o644),
    },
    {
      case: "the rendered proxy's static content changed",
      artifact: "/etc/nginx/sites-available/kajianq.conf",
      source: "provision/vps/nginx/kajianq.conf",
      mutate: (fixture) => {
        const conf = fixture.path("/etc/nginx/sites-available/kajianq.conf");
        writeFileSync(
          conf,
          readFileSync(conf, "utf8").replace(
            "client_max_body_size 1m;",
            "client_max_body_size 2m;",
          ),
        );
      },
    },
    {
      case: "the rendered proxy gained a line",
      artifact: "/etc/nginx/sites-available/kajianq.conf",
      source: "provision/vps/nginx/kajianq.conf",
      mutate: (fixture) => {
        const conf = fixture.path("/etc/nginx/sites-available/kajianq.conf");
        writeFileSync(conf, `${readFileSync(conf, "utf8")}# leftover line\n`);
      },
    },
    {
      case: "a second directive appended to a rendered placeholder line",
      artifact: "/etc/nginx/sites-available/kajianq.conf",
      source: "provision/vps/nginx/kajianq.conf",
      mutate: (fixture) => {
        const conf = fixture.path("/etc/nginx/sites-available/kajianq.conf");
        writeFileSync(
          conf,
          readFileSync(conf, "utf8").replace(
            "proxy_pass http://127.0.0.1:8787;",
            "proxy_pass http://127.0.0.1:8787; proxy_set_header X-Injected yes;",
          ),
        );
      },
    },
    {
      case: "the sites-enabled link retargeted at an older copy",
      artifact: "/etc/nginx/sites-enabled/kajianq.conf",
      source: "/etc/nginx/sites-available/kajianq.conf",
      mutate: (fixture) => {
        const enabled = fixture.path("/etc/nginx/sites-enabled/kajianq.conf");
        const old = fixture.path("/etc/nginx/sites-available/kajianq.conf.old");
        writeFileSync(old, read("provision/vps/nginx/kajianq.conf"));
        rmSync(enabled);
        symlinkSync(old, enabled);
      },
    },
    {
      case: "the sites-enabled link deleted",
      artifact: "/etc/nginx/sites-enabled/kajianq.conf",
      source: "/etc/nginx/sites-available/kajianq.conf",
      mutate: (fixture) => rmSync(fixture.path("/etc/nginx/sites-enabled/kajianq.conf")),
    },
    {
      case: "the sites-enabled link replaced by a regular copy",
      artifact: "/etc/nginx/sites-enabled/kajianq.conf",
      source: "/etc/nginx/sites-available/kajianq.conf",
      detail: "is not a symlink",
      mutate: (fixture) => {
        const enabled = fixture.path("/etc/nginx/sites-enabled/kajianq.conf");
        const target = readFileSync(fixture.path("/etc/nginx/sites-available/kajianq.conf"));
        rmSync(enabled);
        writeFileSync(enabled, target);
      },
    },
    {
      case: "the Postgres posture absent",
      // The refusal names the file apply.sh would write, not the table's glob.
      artifact: "/etc/postgresql/16/main/conf.d/99-kajianq.conf",
      source: "provision/vps/postgres/99-kajianq.conf",
      mutate: (fixture) => rmSync(fixture.path("/etc/postgresql/*/main/conf.d/99-kajianq.conf")),
    },
    {
      case: "the deploy grant's size changed",
      artifact: "/etc/sudoers.d/kajianq-deploy",
      source: "provision/vps/sudoers/kajianq-deploy",
      mutate: (fixture) => {
        const grant = fixture.path("/etc/sudoers.d/kajianq-deploy");
        chmodSync(grant, 0o600);
        writeFileSync(grant, `${readFileSync(grant, "utf8")}# extra\n`);
        chmodSync(grant, 0o440);
      },
    },
  ];

  for (const { case: name, artifact, source, detail, mutate } of MUTATIONS) {
    it(`refuses ${name}, naming the artifact and the remedy`, () => {
      const fixture = driftFixture();
      try {
        mutate(fixture);
        const result = fixture.check();
        expect(result.status, `${name}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(artifact);
        expect(result.stderr).toContain(source);
        expect(result.stderr).toContain("run provision/vps/apply.sh");
        expect(result.stderr).toContain(mismatchCount(1));
        expect(result.stderr).not.toContain("could not be compared");
        if (detail) expect(result.stderr).toContain(detail);
      } finally {
        fixture.cleanup();
      }
    });
  }

  it("resolves a versioned destination from the first conf.d directory, as apply.sh does", () => {
    // apply.sh installs the Postgres posture into the first conf.d DIRECTORY
    // (`ls -d /etc/postgresql/*/main/conf.d | head -1`), whether or not it already
    // holds the file. Resolving the first existing FILE instead lets a matching
    // copy in a later major version hide an apply that never wrote its target.
    const fixture = driftFixture();
    try {
      const applyTarget = fixture.path("/etc/postgresql/15/main/conf.d/99-kajianq.conf");
      mkdirSync(dirname(applyTarget), { recursive: true });

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(applyTarget);
      expect(result.stderr).toContain(mismatchCount(1));

      // Once apply.sh's own target exists, it is what the check compares; the
      // matching copy under the later version is not the installed artifact.
      writeFileSync(applyTarget, read("provision/vps/postgres/99-kajianq.conf"));
      chmodSync(applyTarget, 0o644);
      const green = fixture.check();
      expect(green.status, green.stderr).toBe(0);
      expect(green.stdout).toContain(`(${PROVISIONED_ARTIFACTS})`);
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves a version glob that shares its directory component with fixed text", () => {
    // The static prefix is the directory that holds the glob, not the text
    // before its `*`: read as a path, `postgresql-` does not exist, and the row
    // would be skipped as "not installed" while apply.sh installs into the
    // first match of the glob.
    const checkout = checkoutWithTable((table) =>
      table.replace(
        "|/etc/postgresql/*/main/conf.d/99-kajianq.conf|",
        "|/etc/postgresql/postgresql-*/main/conf.d/99-kajianq.conf|",
      ),
    );
    const fixture = driftFixture();
    try {
      const manifest = fixtureManifest(emitManifest(checkout.checkout));
      const applyTarget = join(
        fixture.dir,
        "etc/postgresql/postgresql-15/main/conf.d/99-kajianq.conf",
      );
      mkdirSync(dirname(applyTarget), { recursive: true });
      const drifted = `${read("provision/vps/postgres/99-kajianq.conf")}# drift\n`;
      writeFileSync(applyTarget, drifted);
      chmodSync(applyTarget, 0o644);

      const result = fixture.check({ manifest });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`installed ${digest12(drifted)}`);
      expect(result.stderr).not.toContain("no directory matches");
      expect(result.stderr).toContain(mismatchCount(1));
    } finally {
      fixture.cleanup();
      checkout.cleanup();
    }
  });

  it("skips the Postgres row when Postgres is not installed, as apply.sh does", () => {
    // apply.sh resolves the row against the first existing conf.d directory and
    // logs "install postgresql" when there is none. The check must skip the same
    // row — and say that is why, so this case is not confused with a Postgres
    // tree that lost its conf.d directory: refusing would name a remedy apply.sh
    // cannot carry out on that box, so the deploy would fail again on every retry.
    const fixture = driftFixture({ without: ["postgres"] });
    try {
      expect(existsSync(join(fixture.dir, "etc/postgresql"))).toBe(false);
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("no directory matches /etc/postgresql/*/main/conf.d");
      expect(result.stderr).toContain("Postgres is not installed");
      expect(result.stderr).not.toContain("run provision/vps/apply.sh");
      expect(result.stdout).toContain(
        `(${PROVISIONED_ARTIFACTS - 1} of ${PROVISIONED_ARTIFACTS}; 1 skipped`,
      );
      expect(result.stdout).toContain("Postgres is not installed, as apply.sh also skips the row");
    } finally {
      fixture.cleanup();
    }
  });

  it("names the consequence when Postgres is installed but has no conf.d", () => {
    // `/etc/postgresql` present without main/conf.d is not "Postgres is not
    // installed": the installer skips the row and the log/reachability posture
    // is never applied. The check still skips the row apply.sh skips, but it
    // must say that the posture is missing rather than pass a bare skip.
    const fixture = driftFixture({ without: ["postgres"] });
    try {
      mkdirSync(join(fixture.dir, "etc/postgresql/16/main"), { recursive: true });
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("no conf.d directory under");
      expect(result.stderr).toContain("/etc/postgresql");
      expect(result.stderr).toContain("posture is not applied on this box");
      expect(result.stderr).not.toContain("Postgres is not installed");
      expect(result.stdout).toContain("Postgres is installed but has no conf.d");
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses an unreadable /etc/postgresql instead of skipping it", () => {
    // chmod 000 makes the glob expand to nothing for the same reason an absent
    // directory does. The check cannot tell "no Postgres" from "cannot see
    // Postgres", so it must refuse rather than pass the box green.
    const fixture = driftFixture();
    const postgres = join(fixture.dir, "etc/postgresql");
    try {
      chmodSync(postgres, 0o000);
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain("/etc/postgresql");
      expect(result.stderr).not.toContain("no directory matches");
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
    } finally {
      chmodSync(postgres, 0o755);
      fixture.cleanup();
    }
  });

  it("refuses a version directory it cannot search, instead of skipping the row", () => {
    // The file is installed and drifted; only the search bit on `<ver>/main`
    // hides it from the deploy identity. The glob's expansion path — not just
    // the text before its `*` — has to be searched, or the row is skipped with
    // the "Postgres has no conf.d" message while root's apply.sh would place it.
    const fixture = driftFixture();
    const hidden = join(fixture.dir, "etc/postgresql/16/main");
    try {
      const installed = join(hidden, "conf.d/99-kajianq.conf");
      writeFileSync(installed, `${readFileSync(installed, "utf8")}# drift\n`);
      chmodSync(hidden, 0o000);

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain(hidden);
      expect(result.stderr).not.toContain("no conf.d directory");
      expect(result.stderr).not.toContain("no directory matches");
      expect(result.stderr).not.toContain("is not installed");
      expect(result.stderr).toContain(
        `make ${hidden} readable and searchable for the deploy identity, then deploy again`,
      );
      expect(result.stderr).not.toContain("run provision/vps/apply.sh");
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stdout).not.toContain("match the checkout");
    } finally {
      chmodSync(hidden, 0o755);
      fixture.cleanup();
    }
  });

  it("refuses a version directory it cannot enumerate, instead of comparing another", () => {
    // The two versions diverge: root's expansion orders `15` first and apply.sh
    // writes the first match, but the deploy identity cannot enter `15/main`
    // and sees only `16`. Comparing `16` would report the box healthy over a
    // drifted file in the directory the installer actually targets.
    const fixture = driftFixture();
    const older = join(fixture.dir, "etc/postgresql/15/main");
    const versions = join(fixture.dir, "etc/postgresql");
    const firstConfD = () =>
      sh("bash", ["-c", 'ls -d "$1"/*/main/conf.d | head -1', "probe", versions]);
    try {
      const installed = join(older, "conf.d/99-kajianq.conf");
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(installed, `${read("provision/vps/postgres/99-kajianq.conf")}# drift\n`);
      // What root's `ls -d` picks: the same tree without the search bit that
      // stops this identity, which is the whole difference between the two.
      const rootView = firstConfD();
      expect(rootView.status, rootView.stderr).toBe(0);
      expect(rootView.stdout.trim()).toBe(dirname(installed));

      chmodSync(older, 0o000);
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain(older);
      expect(result.stderr).not.toContain("no conf.d directory");
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stdout).not.toContain("match the checkout");
    } finally {
      chmodSync(older, 0o755);
      fixture.cleanup();
    }
  });

  it("refuses a version directory that is itself unsearchable", () => {
    // The search bit can be off on `<ver>` rather than `<ver>/main` — a cluster
    // directory an older Postgres left at 700. Root expands through it; this
    // identity cannot, so no version is compared.
    const fixture = driftFixture();
    const hidden = join(fixture.dir, "etc/postgresql/16");
    try {
      chmodSync(hidden, 0o000);
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain(hidden);
      expect(result.stderr).not.toContain("no conf.d directory");
      expect(result.stderr).toContain(manualCount(1));
    } finally {
      chmodSync(hidden, 0o755);
      fixture.cleanup();
    }
  });

  it("refuses a conf.d directory it cannot search, the fourth expansion level", () => {
    // The last level the walk enters is `conf.d` itself: `16/main` stays
    // enterable, so only a test of that fixed component catches a 000 conf.d.
    // Root's apply.sh resolves the same match and installs into it, so this
    // identity's blind spot must refuse instead of skipping the row.
    const fixture = driftFixture();
    const hidden = join(fixture.dir, "etc/postgresql/16/main/conf.d");
    try {
      chmodSync(hidden, 0o000);
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain(hidden);
      expect(result.stderr).not.toContain("no conf.d directory");
      expect(result.stderr).not.toContain("no directory matches");
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stdout).not.toContain("match the checkout");
    } finally {
      chmodSync(hidden, 0o755);
      fixture.cleanup();
    }
  });

  it("refuses a conf.d that is not a directory, as apply.sh fails to install into it", () => {
    // apply.sh resolves this row with `ls -d`, which matches a regular file and
    // then hands <file>/99-kajianq.conf to install. The check must fail the row
    // too, not read the missing directory as "nothing to place".
    const fixture = driftFixture({ without: ["postgres"] });
    try {
      const confD = fixture.path("/etc/postgresql/*/main/conf.d");
      mkdirSync(dirname(confD), { recursive: true });
      writeFileSync(confD, "not a directory\n");
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("/etc/postgresql/16/main/conf.d is not a directory");
      expect(result.stderr).not.toContain("no directory matches");
      const confDPath = fixture.path("/etc/postgresql/16/main/conf.d");
      expect(result.stderr).toContain(
        `repair Postgres so ${confDPath} is a directory (recreate conf.d), then run provision/vps/apply.sh on the box and deploy again`,
      );
      expect(result.stderr).toContain("removing it alone leaves the row skipped");
      expect(result.stderr).not.toContain(`remove ${confDPath} or repair Postgres`);
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
      expect(result.stderr).toContain(manualCount(1));
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a second versioned row instead of skipping it uncompared", () => {
    // apply.sh resolves a versioned destination for the Postgres row only; a
    // second row carrying a directory glob would reach `install` literally and
    // fail. The check must refuse it, not infer a skip from the glob shape.
    const extra =
      "postgres-log|config|postgres/99-kajianq.conf|/etc/postgresql/*/main/log.d/99-kajianq.conf|root|root|644";
    const checkout = checkoutWithExtraRow(extra);
    const fixture = driftFixture();
    try {
      const manifest = fixtureManifest(emitManifest(checkout.checkout));
      expect(manifest.split("\n").filter(Boolean)).toHaveLength(PROVISIONED_ARTIFACTS + 1);
      const result = fixture.check({ manifest });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("/etc/postgresql/*/main/log.d/99-kajianq.conf");
      expect(result.stderr).toContain("carries a versioned destination");
      expect(result.stderr).not.toContain("no directory matches");
      expect(result.stderr).toContain("repair the artifact table");
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
      expect(result.stderr).toContain(manualCount(1, PROVISIONED_ARTIFACTS + 1));
    } finally {
      fixture.cleanup();
      checkout.cleanup();
    }
  });

  it("refuses an unknown artifact kind without naming the apply remedy", () => {
    // The check compares four kinds. A manifest naming a fifth is a table bug
    // the installer cannot clear: apply.sh would place its own row and the next
    // deploy would refuse the same unknown kind again.
    const fixture = driftFixture();
    try {
      const manifest = fixture.manifest.replace("|config|", "|bogus|");
      expect(manifest).not.toBe(fixture.manifest);
      const result = fixture.check({ manifest });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("unknown artifact kind in the manifest (bogus)");
      expect(result.stderr).toContain("repair the artifact table");
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
      expect(result.stderr).toContain(manualCount(1));
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a render comparison whose scratch file cannot be created", () => {
    // mktemp failing means no comparison ran. That is not a mismatch an apply
    // clears — apply.sh's render() calls the same mktemp — so the refusal names
    // the scratch directory and the run withholds the generic apply closing.
    const fixture = driftFixture();
    try {
      const result = fixture.check({ env: { TMPDIR: "/nonexistent-kajianq-tmp" } });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("comparison scratch file could not be created");
      expect(result.stderr).toContain(
        "/etc/nginx/sites-available/kajianq.conf could not be compared with provision/vps/nginx/kajianq.conf",
      );
      expect(result.stderr).not.toContain("(placeholder values aside)");
      expect(result.stderr).toContain("make the deploy identity's scratch directory writable");
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stderr).not.toContain("run provision/vps/apply.sh");
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a render payload the manifest cannot decode", () => {
    // A corrupt payload names no installed state to install over; the next
    // deploy decodes the same manifest and refuses again, so an apply is not
    // the remedy.
    const fixture = driftFixture();
    try {
      const manifest = fixture.manifest
        .split("\n")
        .map((line) => {
          if (!line.startsWith("nginx-conf|")) return line;
          const cells = line.split("|");
          cells[cells.length - 1] = "this is not base64";
          return cells.join("|");
        })
        .join("\n");
      expect(manifest).not.toBe(fixture.manifest);
      const result = fixture.check({ manifest });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("the template could not be decoded from the manifest");
      expect(result.stderr).toContain(
        "/etc/nginx/sites-available/kajianq.conf could not be compared with provision/vps/nginx/kajianq.conf",
      );
      expect(result.stderr).not.toContain("(placeholder values aside)");
      expect(result.stderr).toContain("re-emit the manifest");
      expect(result.stderr).toContain(manualCount(1));
      expect(result.stderr).not.toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses an unknown kind on a row that is not installed, as the table bug it is", () => {
    // An absent file must not take the "not installed — run apply.sh" branch
    // before the kind is read: that remedy exits 1 on an unknown kind.
    const fixture = driftFixture({ without: ["logrotate-proxy"] });
    try {
      const manifest = fixture.manifest.replace("|config|", "|bogus|");
      expect(manifest).not.toBe(fixture.manifest);
      const result = fixture.check({ manifest });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("unknown artifact kind in the manifest (bogus)");
      expect(result.stderr).toContain("repair the artifact table");
      expect(result.stderr).not.toContain("is not installed");
      expect(result.stderr).not.toContain("run provision/vps/apply.sh");
      expect(result.stderr).toContain(manualCount(1));
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the refusals it collected when the loop dies mid-run", () => {
    // A directory where a config file is expected passes the owner/mode check
    // and then makes the unguarded sha256sum exit under `set -e`. The refusal
    // already gathered for the drifted unit must still reach the operator.
    const fixture = driftFixture();
    try {
      const api = fixture.path("/etc/systemd/system/kajianq-api.service");
      writeFileSync(api, `${readFileSync(api, "utf8")}# edited\n`);
      const cron = fixture.path("/etc/systemd/system/kajianq-cron.service");
      rmSync(cron);
      mkdirSync(cron);
      chmodSync(cron, 0o644);

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Is a directory");
      expect(result.stderr).toContain(
        "/etc/systemd/system/kajianq-api.service differs from provision/vps/systemd/kajianq-api.service",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("names each refusal's class where the remedy is known", () => {
    // The class is not a list of sites kept in step by hand: a call site passes
    // "apply" or "manual" as a literal, and `refuse` rejects anything else, so a
    // new refusal cannot inherit a default or a second counter.
    const script = read("provision/vps/deploy/provision-drift.sh");
    const classes = [...script.matchAll(/^\s*refuse (\S+) \\$/gm)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    expect(new Set(classes)).toEqual(new Set(["apply", "manual"]));
    expect(script).not.toMatch(/^\s*refuse\s+"/m);
    expect(script).not.toContain("refuse_uncleared_by_apply");
  });

  it("carries a rendered mismatch out of a command substitution", () => {
    // A mismatch reason stored in a variable disappears when the comparison runs
    // in a subshell. The reason must travel as render_matches' output, so a call
    // site inside `$(...)` still hands it to the refusal.
    const dir = mkdtempSync(join(tmpdir(), "kajianq-render-probe-"));
    try {
      const installed = join(dir, "kajianq.conf");
      const rendered = renderTemplate(read("provision/vps/nginx/kajianq.conf"));
      writeFileSync(installed, `${rendered}# extra line\n`);
      const probe = sh("bash", [
        "-c",
        [
          "set -euo pipefail",
          renderMatchesSource(),
          'reason="$(render_matches "$1" "$2")" || status=$?',
          'printf "status=%s\\nreason=%s\\n" "${status:-0}" "${reason}"',
        ].join("\n"),
        "probe",
        installed,
        Buffer.from(rendered).toString("base64"),
      ]);
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout).toContain("status=1");
      expect(probe.stdout).toContain("the installed copy has");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the expected and installed digests, and the first mismatching rendered line", () => {
    const fixture = driftFixture();
    try {
      const original = read("provision/vps/systemd/kajianq-api.service");
      const edited = original.replace("Description=", "Description=edited ");
      const unit = fixture.path("/etc/systemd/system/kajianq-api.service");
      writeFileSync(unit, edited);
      const conf = fixture.path("/etc/nginx/sites-available/kajianq.conf");
      writeFileSync(
        conf,
        readFileSync(conf, "utf8").replace("client_max_body_size 1m;", "client_max_body_size 2m;"),
      );

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(mismatchCount(2));
      expect(result.stderr).toContain(`checkout sha256 ${digest12(original)}`);
      expect(result.stderr).toContain(`installed ${digest12(edited)}`);
      const line =
        read("provision/vps/nginx/kajianq.conf")
          .split("\n")
          .findIndex((text) => text.includes("client_max_body_size 1m;")) + 1;
      expect(result.stderr).toContain(`line ${line} differs`);
      expect(result.stderr).toContain("client_max_body_size 2m;");
      expect(result.stderr).toContain("client_max_body_size 1m;");
    } finally {
      fixture.cleanup();
    }
  });

  it("treats a changed placeholder value as box configuration, not drift", () => {
    // proxy.env holds the domain, TLS paths and upstream. Only the repository
    // template is drift; the values are the box's, and a deploy must not demand
    // an apply because the domain changed.
    const fixture = driftFixture();
    try {
      const conf = fixture.path("/etc/nginx/sites-available/kajianq.conf");
      writeFileSync(
        conf,
        renderTemplate(read("provision/vps/nginx/kajianq.conf"), {
          __KAJIANQ_DOMAIN__: "other.example.test",
          __KAJIANQ_API_UPSTREAM__: "http://127.0.0.1:9999",
        }),
      );
      const result = fixture.check();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports every drifted artifact in one run", () => {
    const fixture = driftFixture();
    try {
      rmSync(fixture.path("/usr/local/sbin/kajianq-backup-pending"));
      const unit = fixture.path("/etc/systemd/system/kajianq-api.service");
      writeFileSync(unit, `${readFileSync(unit, "utf8")}# edited\n`);
      const timer = fixture.path("/etc/systemd/system/kajianq-cron.timer");
      writeFileSync(timer, `${readFileSync(timer, "utf8")}# edited\n`);

      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(mismatchCount(3));
      for (const artifact of [
        "/usr/local/sbin/kajianq-backup-pending",
        "/etc/systemd/system/kajianq-api.service",
        "/etc/systemd/system/kajianq-cron.timer",
      ]) {
        expect(result.stderr).toContain(artifact);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("withholds the generic closing when a mixed run holds a comparison that could not run", () => {
    // One mismatch an apply clears and one refusal it cannot: the count line
    // covers both states once, the mismatch keeps its per-file apply line, and
    // the run does not close with the generic apply remedy.
    const fixture = driftFixture();
    const hidden = join(fixture.dir, "etc/postgresql/16/main");
    try {
      const unit = fixture.path("/etc/systemd/system/kajianq-backup.service");
      writeFileSync(unit, `${readFileSync(unit, "utf8")}# drift\n`);
      chmodSync(hidden, 0o000);

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(manualCount(2));
      expect(countOf(result.stderr, "provisioned artifact(s)")).toBe(1);
      expect(result.stderr).toContain("cannot read or search");
      expect(result.stderr).toContain(
        `make ${hidden} readable and searchable for the deploy identity, then deploy again`,
      );
      expect(result.stderr).toContain(
        "/etc/systemd/system/kajianq-backup.service differs from provision/vps/systemd/kajianq-backup.service",
      );
      expect(result.stderr).not.toContain(mismatchCount(2));
      expect(result.stderr).not.toContain("from a checkout of the revision being deployed");
    } finally {
      chmodSync(hidden, 0o755);
      fixture.cleanup();
    }
  });

  it("keeps the plain count line and the generic closing when every refusal is a mismatch", () => {
    // The run-level rule's other side: two mismatches and no manual refusal
    // still end with the apply remedy the operator can act on.
    const fixture = driftFixture();
    try {
      for (const artifact of [
        "/etc/systemd/system/kajianq-api.service",
        "/etc/systemd/system/kajianq-backup.service",
      ]) {
        const path = fixture.path(artifact);
        writeFileSync(path, `${readFileSync(path, "utf8")}# drift\n`);
      }

      const result = fixture.check();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(mismatchCount(2));
      expect(countOf(result.stderr, "provisioned artifact(s)")).toBe(1);
      expect(result.stderr).not.toContain("could not be compared");
      expect(result.stderr).toContain(
        "run provision/vps/apply.sh on the box from a checkout of the revision being deployed, then deploy again",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("gives the same verdict from the base64 manifest the deploy passes", () => {
    const fixture = driftFixture();
    try {
      const synced = fixture.check({ base64: true });
      expect(synced.status, synced.stderr).toBe(0);

      const unit = fixture.path("/etc/systemd/system/kajianq-backup.service");
      writeFileSync(unit, readFileSync(unit, "utf8").replace(/^Type=oneshot$/m, "Type=simple"));
      const drifted = fixture.check({ base64: true });
      expect(drifted.status).toBe(1);
      expect(drifted.stderr).toContain("/etc/systemd/system/kajianq-backup.service");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("deploy.sh wiring", () => {
  it("runs the drift preflight before the provenance gate and the first mutation", () => {
    const script = read("provision/vps/deploy/deploy.sh");
    const driftAt = script.indexOf('--emit-manifest "${REPO_DIR}"');
    const provenanceAt = script.indexOf('<"${REPO_DIR}/provision/vps/deploy/backup-provenance.sh"');
    expect(driftAt).toBeGreaterThan(-1);
    expect(provenanceAt).toBeGreaterThan(-1);
    expect(driftAt).toBeLessThan(provenanceAt);
    for (const mutation of [
      "bun run build:web",
      "rsync -az",
      "sudo ${SYSTEMCTL} restart",
      "sudo ${SYSTEMCTL} start kajianq-cron.service",
    ]) {
      const at = script.indexOf(mutation);
      expect(at, `deploy.sh must still contain: ${mutation}`).toBeGreaterThan(-1);
      expect(driftAt, `the drift preflight must precede ${mutation}`).toBeLessThan(at);
    }
  });

  it("ships the checker over ssh and passes the manifest on argv, changing no installed state", () => {
    const script = read("provision/vps/deploy/deploy.sh");
    const start = script.indexOf('log "preflight: provisioned artifacts match the checkout"');
    const end = script.indexOf("# --- 0b. preflight");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);
    // The file the tests execute is the file the box runs: piped into `bash -s`.
    expect(block).toMatch(/bash -s --[\s\S]*--check --manifest-base64/);
    expect(block).toMatch(/<"\$\{REPO_DIR\}\/provision\/vps\/deploy\/provision-drift\.sh"/);
    // No installed state changes on the box: no ship, no privilege, no unit
    // action. Comparing a rendered config writes one short-lived file under
    // /tmp, which the checker removes before it returns.
    for (const forbidden of ["rsync", "sudo ", "systemctl", "bun run", "install "]) {
      expect(block, `the drift preflight must not run: ${forbidden}`).not.toContain(forbidden);
    }
    // Production checks the box's real paths; --root is the tests' seam.
    expect(script).not.toContain("--root");
  });
});
