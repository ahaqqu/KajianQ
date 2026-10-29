import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI's own brake tests, spawned rather than imported.
 *
 * A flag validated inside `runSanadsetStudy` is validated after the archive has been
 * hashed — 1.4 GB of I/O for an argument that was already wrong. These tests hold the CLI
 * to the order: the ceiling, the provider and the artifact directory are checked before a
 * byte is read, and the missing archive they point at proves which error came first.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(REPO, "packages/kajianq-domain/scripts/sanadset-study.mjs");
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
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("the study CLI", () => {
  it("prints usage and exits 0 on --help", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("study:sanadset");
    expect(result.stdout).toContain("--max-calls");
  });

  it("refuses --max-calls above the hard ceiling before reading the archive", () => {
    const result = runCli(["--max-calls", "7000", "--csv", MISSING_ARCHIVE]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exceeds the hard ceiling 6000");
    // The archive was never opened: the argument was rejected first.
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).not.toContain("no such file");
  });

  it("refuses an artifact directory inside the repository", () => {
    const result = runCli(["--no-model", "--out", ".", "--csv", MISSING_ARCHIVE]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolves inside the repository");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("refuses SANADSET_STUDY_DIR inside the repository", () => {
    const result = runCli(["--no-model", "--csv", MISSING_ARCHIVE], {
      SANADSET_STUDY_DIR: join(REPO, "packages"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolves inside the repository");
  });

  it("refuses a provider the configuration does not list, naming the ones it does", () => {
    const result = runCli(["--provider", "made-up", "--csv", MISSING_ARCHIVE]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dashscope, ollama");
  });
});
