import { readFileSync } from "node:fs";
import { parseTemplateSyncManifest } from "../../packages/contracts/src/index.ts";

/**
 * Load and validate `template-sync.json` using the project Valibot contract.
 *
 * @param {string} path
 * @returns {import("@app/contracts").TemplateSyncManifest}
 */
export function loadManifest(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return parseTemplateSyncManifest(raw);
}

/** True when a path is covered by an overwrite entry. */
export function isOverwritePath(manifest, p) {
  return manifest.overwrite.some((e) =>
    p === e || p.startsWith(e.endsWith("/") ? e : `${e}/`),
  );
}

/** True when a path is covered by a merge entry. */
export function isMergePath(manifest, p) {
  return manifest.merge.some((e) =>
    p === e || p.startsWith(e.endsWith("/") ? e : `${e}/`),
  );
}
