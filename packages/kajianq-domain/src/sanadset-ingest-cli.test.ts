import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ingest CLI's brake tests, spawned rather than imported.
 *
 * Test intent, named before the assertions:
 * - trap: the archive must not be opened before the gate decides. Every refusal test
 *   points the CLI at a missing CSV and asserts the refusal message with no ENOENT —
 *   a gate that runs after the 1.4 GB read would spend minutes before refusing;
 * - trap: the label's *existence* is not verification. A label with no object store is
 *   asserted to refuse with the verifier's own reason, not to proceed because a label
 *   was supplied;
 * - trap: the test escape must be the only way past the gate without a snapshot, and
 *   it must reach the archive (the missing file then surfaces) — proving the escape is
 *   what allowed it, not a skipped check.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(REPO, "packages/kajianq-domain/scripts/sanadset-ingest.mjs");
const MISSING_ARCHIVE = join(REPO, "does-not-exist", "sanadset.csv");

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(args: readonly string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync("bun", [CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const FAKE_DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";

describe("the ingest CLI", () => {
  it("prints usage and exits 0 on --help", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ingest:sanadset");
    expect(result.stdout).toContain("--snapshot");
    expect(result.stdout).toContain("--test-allow-no-snapshot");
  });

  it("refuses to write without a snapshot label before opening the archive", () => {
    const result = runCli(["--collection", "bukhari", "--csv", MISSING_ARCHIVE], {
      DATABASE_URL: FAKE_DATABASE_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to write: no verified pre-ingest snapshot");
    expect(result.stderr).toContain("no snapshot label was given");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("refuses a supplied label that cannot be verified", () => {
    const result = runCli(
      [
        "--collection",
        "bukhari",
        "--snapshot",
        "pre-ingest-unverifiable",
        "--csv",
        MISSING_ARCHIVE,
      ],
      {
        DATABASE_URL: FAKE_DATABASE_URL,
        R2_ACCOUNT_ID: "",
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('snapshot "pre-ingest-unverifiable" is not verified');
    expect(result.stderr).toContain("db-snapshot");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("refuses without DATABASE_URL: an integrity-only verify is not a verified snapshot", () => {
    const result = runCli(["--collection", "bukhari", "--snapshot", "pre-ingest-unverifiable"], {
      DATABASE_URL: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });

  it("names the pilot's one collection when given another", () => {
    const result = runCli(["--collection", "muslim", "--dry-run"], {
      DATABASE_URL: FAKE_DATABASE_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bukhari");
    expect(result.stderr).toContain("one collection");
  });

  it("refuses a run id that is not a slug, before the archive is read", () => {
    const result = runCli(["--collection", "bukhari", "--run-id", "../escape", "--dry-run"], {
      DATABASE_URL: FAKE_DATABASE_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--run-id must match");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("refuses a report path inside the checkout before the run", () => {
    const result = runCli(["--collection", "bukhari", "--report", "report.json", "--dry-run"], {
      DATABASE_URL: FAKE_DATABASE_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolves inside the repository");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("lets the explicit test escape past the gate and on to the archive", () => {
    const result = runCli(
      [
        "--collection",
        "bukhari",
        "--dry-run",
        "--test-allow-no-snapshot",
        "--csv",
        MISSING_ARCHIVE,
      ],
      { DATABASE_URL: FAKE_DATABASE_URL },
    );
    expect(result.status).not.toBe(0);
    // The gate allowed the run: the failure is the missing archive the test pointed at.
    expect(result.stdout).toContain("gate resolved");
    expect(result.stdout).toContain('"mode":"dry-run"');
    expect(result.stderr).toContain("ENOENT");
  });
});
