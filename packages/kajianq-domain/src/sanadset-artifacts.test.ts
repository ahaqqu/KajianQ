import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertArtifactDirWritable,
  assertOutsideRepository,
  LABELS_CSV,
  defaultCsvPath,
  repositoryRoots,
  resolveOutDir,
  SPOT_CHECK_CSV,
  StudyArtifactDirError,
  writeArtifactFiles,
} from "./sanadset-artifacts";

/**
 * Test intent, named before the assertions:
 * - trap: the artifact writer must never write into the checkout. The refusal is asserted
 *   through the real path AND through a symlink, because a default that holds only while
 *   nobody points `--out` at the repository is not an invariant;
 * - trap: every working tree of the repository is a checkout. The guard is asked from a
 *   linked worktree and must still refuse the main checkout, and the reverse;
 * - trap: a scored label sheet is evidence. A rerun into the same directory must stop
 *   before writing, not overwrite the sheet the owner spent paid attention on;
 * - trap: the default paths come from the injected environment, so a test can resolve
 *   them without touching the machine's real configuration.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ENVIRONMENT = { env: {}, homeDir: "/home/test" };

describe("the artifact directory", () => {
  it("refuses a directory inside the checkout", () => {
    expect(() => assertOutsideRepository(join(REPO, "packages"))).toThrow(StudyArtifactDirError);
    expect(() => assertOutsideRepository(join(REPO, "packages"))).toThrow(
      /resolves inside the repository/u,
    );
    expect(() => assertOutsideRepository(REPO)).toThrow(/resolves inside the repository/u);
  });

  it("refuses a symlink that resolves into the checkout", () => {
    const outside = mkdtempSync(join(tmpdir(), "sanadset-link-"));
    const link = join(outside, "sneaky");
    symlinkSync(join(REPO, "packages"), link);
    expect(() => assertOutsideRepository(link)).toThrow(/resolves inside the repository/u);
  });

  it("refuses the main checkout from a linked worktree, and the linked tree from the main one", () => {
    const root = mkdtempSync(join(tmpdir(), "sanadset-worktrees-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    git("init", "-q");
    writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
    git("add", "README.md");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
    const linked = join(root, "linked");
    git("worktree", "add", "-q", "--detach", linked);

    const roots = repositoryRoots(linked).map((path) => realpathSync(path));
    expect(roots).toContain(realpathSync(root));
    expect(() => assertOutsideRepository(join(root, "artifacts"), { from: linked })).toThrow(
      /resolves inside the repository/u,
    );
    expect(() => assertOutsideRepository(join(linked, "artifacts"), { from: root })).toThrow(
      /resolves inside the repository/u,
    );
  });

  it("accepts a directory outside the checkout, existing or not", () => {
    const outside = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    expect(() => assertOutsideRepository(outside)).not.toThrow();
    expect(() => assertOutsideRepository(join(outside, "not-created-yet"))).not.toThrow();
  });

  it("writes every file into the directory it was given", () => {
    const outside = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const written = writeArtifactFiles(join(outside, "run-1"), [
      { name: "report.md", content: "# report\n" },
      { name: "sample.json", content: "{}\n" },
    ]);
    expect(written).toEqual([
      join(outside, "run-1", "report.md"),
      join(outside, "run-1", "sample.json"),
    ]);
    expect(readFileSync(join(outside, "run-1", "report.md"), "utf8")).toBe("# report\n");
  });

  it("refuses to write into the checkout even when the caller asks", () => {
    const target = join(REPO, ".sanadset-test-artifacts");
    expect(() => writeArtifactFiles(target, [{ name: "report.md", content: "x" }])).toThrow(
      /resolves inside the repository/u,
    );
    expect(existsSync(target)).toBe(false);
  });
});

describe("the scored-label guard", () => {
  it("lets a fresh or unlabelled directory through", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-labels-"));
    expect(() => assertArtifactDirWritable(dir)).not.toThrow();
    writeFileSync(
      join(dir, LABELS_CSV),
      "pair_id,kind,a,b,label,notes\r\nP001,matn,a,b,,\r\nP002,matn,c,d,,\r\n",
      "utf8",
    );
    expect(() => assertArtifactDirWritable(dir)).not.toThrow();
  });

  it("refuses a directory whose label sheet carries a score", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-labels-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SPOT_CHECK_CSV),
      "pair_id,kind,a,b,label,notes\r\nP001,matn,a,b,different,owner\r\n",
      "utf8",
    );
    expect(() => assertArtifactDirWritable(dir)).toThrow(/already carries scored labels/u);
  });
});

describe("the default paths", () => {
  it("takes an override from the injected environment", () => {
    expect(defaultCsvPath({ env: { SANADSET_CSV: "/data/x.csv" }, homeDir: "/home/test" })).toBe(
      "/data/x.csv",
    );
    expect(defaultCsvPath({ env: { SANADSET_CSV: "   " }, homeDir: "/home/test" })).toBe(
      "/home/test/.cache/kajianq/sanadset/sanadset.csv",
    );
  });

  it("resolves the artifact directory under the injected home, and refuses an in-repo override", () => {
    expect(resolveOutDir(ENVIRONMENT)).toBe("/home/test/.cache/kajianq/sanadset-pilot");
    expect(() =>
      resolveOutDir({ env: { SANADSET_STUDY_DIR: join(REPO, "dist") }, homeDir: "/h" }),
    ).toThrow(/resolves inside the repository/u);
  });
});
