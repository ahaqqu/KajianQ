import { spawnSync } from "node:child_process";
import { createLogger } from "../../packages/infra/src/index.ts";

const DEFAULT_REMOTE = "upstream";

/**
 * Create git helpers bound to a working directory and logger.
 *
 * @param {{ cwd: string; log: import("@app/infra").Logger; remote?: string }} ctx
 */
export function createGit({ cwd, log, remote = DEFAULT_REMOTE }) {
  const git = (args) =>
    spawnSync("git", ["--no-pager", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_PROTOCOL_FROM_USER: "false" },
    });

  const gitOk = (args) => git(args).status === 0;

  const gitOut = (args) => {
    const r = git(args);
    return r.status === 0 ? r.stdout.trim() : null;
  };

  return { git, gitOk, gitOut, remote, log };
}

/**
 * Strip credentials, scheme, .git suffix, and trailing slashes so URLs can be
 * compared regardless of transport.
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url.replace(/^git@([^:]+):/, "https://$1/"));
    const host = u.hostname;
    const path = u.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url
      .replace(/^git@([^:]+):/, "$1/")
      .replace(/^ssh:\/\//, "")
      .replace(/^https:\/\//, "")
      .replace(/^http:\/\//, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  }
}

/** Remove userinfo from a URL before logging it. */
export function redactUrl(url) {
  try {
    const u = new URL(url.replace(/^git@([^:]+):/, "https://$1/"));
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\.git$/, "");
  } catch {
    return url.includes("@") ? "<redacted>" : url;
  }
}

/** Resolve the upstream URL from env or manifest, normalizing GitHub SSH to HTTPS for git operations. */
export function upstreamUrl(manifest, env = process.env) {
  const raw = env.TEMPLATE_SYNC_UPSTREAM || manifest.upstream;
  // GitHub Actions and anonymous forks can only fetch HTTPS. Convert the
  // canonical SSH form to HTTPS for actual git operations while keeping the
  // manifest free of transport assumptions.
  return raw
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/github\.com\//, "https://github.com/");
}

/** True when the origin remote points to the template repo itself. */
export function isTemplateRepo({ gitOut, remote, manifest, env = process.env }) {
  const origin = gitOut(["remote", "get-url", "origin"]);
  if (!origin) return false;
  return normalizeUrl(origin) === normalizeUrl(upstreamUrl(manifest, env));
}

/** Ensure the upstream remote exists and points at the expected URL. */
export function ensureRemote({ git, gitOk, gitOut, remote, log, manifest, env = process.env }) {
  const expected = upstreamUrl(manifest, env);
  const existing = gitOk(["remote", "get-url", remote]);

  if (existing) {
    const actual = gitOut(["remote", "get-url", remote]);
    if (normalizeUrl(actual ?? "") !== normalizeUrl(expected)) {
      log.error("upstream remote url mismatch", {
        remote,
        expected: redactUrl(expected),
        actual: redactUrl(actual ?? ""),
      });
      throw new Error(
        `Remote "${remote}" exists but points to ${redactUrl(actual ?? "")}; expected ${redactUrl(expected)}. Remove or rename it first.`,
      );
    }
    return;
  }

  const r = git(["remote", "add", remote, expected]);
  if (r.status !== 0) {
    log.error("git remote add failed", { stderr: r.stderr });
    throw new Error(`git remote add ${remote} failed:\n${r.stderr}`);
  }
  log.info("upstream remote added", { remote, upstream: redactUrl(expected) });
}

/** Fetch tags from the upstream remote. */
export function fetchUpstream({ git, remote, log }) {
  const r = git(["fetch", "--tags", "--quiet", remote]);
  if (r.status !== 0) {
    log.error("git fetch upstream failed", { stderr: r.stderr });
    throw new Error(`git fetch ${remote} failed:\n${r.stderr}`);
  }
}

/** Resolve the default ref (latest upstream v* tag, else the remote default branch). */
export function resolveRef({ gitOut, remote }, arg) {
  if (arg) return arg;
  const lsRemote = gitOut([
    "ls-remote",
    "--tags",
    "--sort=-v:refname",
    remote,
    "refs/tags/v*",
  ]);
  if (lsRemote) {
    const line = lsRemote.split("\n")[0];
    const match = line.match(/refs\/tags\/(v[^\s^{]+)/);
    if (match) return match[1];
  }
  return "main";
}

/** Resolve a ref or tag to a commit on the upstream remote. */
export function resolveCommit({ gitOut, remote }, ref) {
  return (
    gitOut(["rev-parse", "--verify", `refs/remotes/${remote}/${ref}^{commit}`]) ??
    gitOut(["rev-parse", "--verify", `refs/tags/${ref}^{commit}`]) ??
    gitOut(["rev-parse", "--verify", `${ref}^{commit}`])
  );
}

/** Fail if the working tree has staged or unstaged changes. */
export function assertCleanWorktree({ gitOut, log }) {
  const status = gitOut(["status", "--porcelain"]);
  if (status && status.trim()) {
    log.error("working tree is not clean", { status });
    throw new Error(
      "Working tree is not clean. Commit or stash local changes before syncing.",
    );
  }
}

export function createSyncLogger() {
  return createLogger({ service: "template-sync" });
}
