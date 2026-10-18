/**
 * provenance.mjs — the backup job's durable run record, split from
 * kajianq-backup.mjs so its directory and permission contract can be tested
 * without running a backup.
 *
 * The record lives outside the deployed tree, under a root-owned directory: the
 * deploy identity reads it to prove the backup job has completed since the
 * current unit was installed, and cannot write it. Only a root process can
 * produce a record there.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The production record directory; root-owned, world-traversable, not deploy-owned. */
export const RECORD_DIR = "/var/lib/kajianq";

/** The production record path, shared by the writer and the deploy preflight. */
export const RECORD_PATH = `${RECORD_DIR}/backup-provenance`;

/** The record's fields, one `key=value` per line, so the bash preflight parses it without a JSON dependency. */
export function recordBody({ status, startedAt, completedAt, label, revision }) {
  return [
    `status=${status}`,
    `started_at=${startedAt}`,
    `completed_at=${completedAt}`,
    `label=${label}`,
    `revision=${revision}`,
    "",
  ].join("\n");
}

/**
 * Ensure the record's directory exists.
 *
 * Only the production directory is made world-traversable: the deploy identity
 * must reach the record. A caller-supplied directory (the restore drill's
 * scratch path, a test fixture) is left as its owner set it — widening a shared
 * directory the backup job does not own is not this function's decision.
 */
export function ensureRecordDir(dir, productionDir = RECORD_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (dir === productionDir) chmodSync(dir, 0o755);
}

/** Write the record atomically at 0644, so a reader never sees a partial one. */
export function writeRecordFile(path, body) {
  const dir = dirname(path);
  ensureRecordDir(dir);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, body, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}
