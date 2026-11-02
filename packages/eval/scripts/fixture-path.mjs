/**
 * fixture-path.mjs — the one fixture-path resolver the eval CLIs share.
 *
 * A configured fixture path is either absolute — an override pointing anywhere, the
 * shape the config contract accepts — or relative to the process's working directory,
 * which is how the checked-in defaults are written. Prefixing every path with the cwd
 * silently breaks the first form (`<cwd>//abs/path`), so both forms resolve here, once,
 * and `eval:run`, `eval:smoke` and `eval:probes` cannot disagree.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Resolve one configured fixture path against the caller's working directory. */
export function resolveFixturePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Read a fixture's text from a configured path (absolute or cwd-relative). */
export function readFixtureText(cwd, path) {
  return readFileSync(resolveFixturePath(cwd, path), "utf8");
}
