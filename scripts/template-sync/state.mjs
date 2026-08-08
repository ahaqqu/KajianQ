import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { parseTemplateSyncState } from "../../packages/contracts/src/index.ts";

/**
 * Read `.template-sync.state` if it exists and is valid.
 *
 * @param {string} path
 * @returns {import("@app/contracts").TemplateSyncState | null}
 */
export function readState(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  try {
    return parseTemplateSyncState(raw);
  } catch {
    return null;
  }
}

/**
 * Write `.template-sync.state`.
 *
 * @param {string} path
 * @param {import("@app/contracts").TemplateSyncState} state
 */
export function writeState(path, { ref, commit }) {
  writeFileSync(path, JSON.stringify({ ref, commit }, null, 2) + "\n");
}

/**
 * Read `.template-sync.pending` if it exists.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function readPending(path) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Remove `.template-sync.pending`.
 *
 * @param {string} path
 */
export function clearPending(path) {
  try {
    rmSync(path);
  } catch {
    // nothing pending
  }
}
