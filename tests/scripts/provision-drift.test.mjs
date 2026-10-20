import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
 * Every file apply.sh places. A new row in its table must be added here too —
 * the count is the coverage check for "every artifact the deploy depends on".
 */
const PROVISIONED_ARTIFACTS = 12;

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
function emitManifest() {
  const result = sh("bash", [DRIFT, "--emit-manifest", REPO]);
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
function driftFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-drift-"));
  const rows = artifacts();
  const template = (row) => read(join("provision/vps", row.src));
  const path = (dst) => join(dir, dst.replace(/^\//, "").replace("*", "16"));
  for (const row of rows) {
    const installed = path(row.dst);
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, row.kind === "render" ? renderTemplate(template(row)) : template(row));
    chmodSync(installed, parseInt(row.mode, 8));
  }
  const manifest = fixtureManifest(emitManifest());
  return {
    dir,
    rows,
    manifest,
    path,
    install: (row) => {
      const installed = path(row.dst);
      writeFileSync(
        installed,
        row.kind === "render" ? renderTemplate(template(row)) : template(row),
      );
      chmodSync(installed, parseInt(row.mode, 8));
    },
    check: ({ manifest: given = manifest, base64 = false } = {}) =>
      base64
        ? sh("bash", [
            DRIFT,
            "--check",
            "--root",
            dir,
            "--manifest-base64",
            Buffer.from(given).toString("base64"),
          ])
        : sh("bash", [DRIFT, "--check", "--root", dir], { input: given }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run the shipped provenance gate against a fixture unit and record. */
function provenance(unit, record) {
  return sh("bash", [resolve(REPO, "provision/vps/deploy/backup-provenance.sh"), unit, record]);
}

describe("the artifact set is enumerated from apply.sh itself", () => {
  it("lists every file apply.sh places, with its destination, owner and mode", () => {
    const rows = artifacts();
    expect(rows.length, "every provisioned artifact must be listed").toBe(PROVISIONED_ARTIFACTS);
    for (const row of rows) {
      expect(row.kind, row.name).toMatch(/^(config|render|sudoers)$/);
      expect(row.dst, row.name).toMatch(/^\//);
      expect(row.owner, row.name).toBe("root");
      expect(row.group, row.name).toBe("root");
      expect(() => statSync(resolve(REPO, "provision/vps", row.src)), row.src).not.toThrow();
    }
    const byName = new Map(rows.map((row) => [row.name, row]));
    // The artifacts the deploy's own verdict reads: the units it restarts, the
    // marker the backup unit's ExecStartPre runs, the grant its sudo calls need.
    expect(byName.get("backup-unit").dst).toBe("/etc/systemd/system/kajianq-backup.service");
    expect(byName.get("api-unit").dst).toBe("/etc/systemd/system/kajianq-api.service");
    expect(byName.get("backup-marker").dst).toBe("/usr/local/sbin/kajianq-backup-pending");
    expect(byName.get("backup-marker").mode).toBe("755");
    expect(byName.get("deploy-grant").mode).toBe("440");
    expect(byName.get("nginx-conf").kind).toBe("render");
    expect(byName.get("postgres").dst).toBe("/etc/postgresql/*/main/conf.d/99-kajianq.conf");
  });

  it("has one install site per row and no install that bypasses the table", () => {
    const apply = read("provision/vps/apply.sh");
    const calls = [...apply.matchAll(/^\s*install_artifact (\S+)/gm)].map((match) => match[1]);
    expect(new Set(calls)).toEqual(new Set(artifacts().map((row) => row.name)));
    expect(calls.length).toBe(PROVISIONED_ARTIFACTS);
    // A direct install would place a file the drift check never hears about.
    expect(apply).not.toMatch(/^(run )?install_config "\$\{SRC\}/m);
    expect(apply).not.toMatch(/^render "\$\{SRC\}/m);
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
      expect(drift.stderr).toContain(`1 of ${PROVISIONED_ARTIFACTS}`);
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
      case: "the Postgres posture absent",
      artifact: "/etc/postgresql/*/main/conf.d/99-kajianq.conf",
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

  for (const { case: name, artifact, source, mutate } of MUTATIONS) {
    it(`refuses ${name}, naming the artifact and the remedy`, () => {
      const fixture = driftFixture();
      try {
        mutate(fixture);
        const result = fixture.check();
        expect(result.status, `${name}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(artifact);
        expect(result.stderr).toContain(source);
        expect(result.stderr).toContain("run provision/vps/apply.sh");
        expect(result.stderr).toContain(`1 of ${PROVISIONED_ARTIFACTS}`);
      } finally {
        fixture.cleanup();
      }
    });
  }

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
      expect(result.stderr).toContain(`3 of ${PROVISIONED_ARTIFACTS}`);
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

  it("ships the checker over ssh and passes the manifest on argv, read-only", () => {
    const script = read("provision/vps/deploy/deploy.sh");
    const start = script.indexOf('log "preflight: provisioned artifacts match the checkout"');
    const end = script.indexOf("# --- 0b. preflight");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);
    // The file the tests execute is the file the box runs: piped into `bash -s`.
    expect(block).toMatch(/bash -s --[\s\S]*--check --manifest-base64/);
    expect(block).toMatch(/<"\$\{REPO_DIR\}\/provision\/vps\/deploy\/provision-drift\.sh"/);
    // Read-only on the box: no mutation, no privilege.
    for (const forbidden of ["rsync", "sudo ", "systemctl", "bun run", "install "]) {
      expect(block, `the drift preflight must not run: ${forbidden}`).not.toContain(forbidden);
    }
    // Production checks the box's real paths; --root is the tests' seam.
    expect(script).not.toContain("--root");
  });
});
