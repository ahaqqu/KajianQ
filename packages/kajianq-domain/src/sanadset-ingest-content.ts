/**
 * Content identity for the pilot's child rows.
 *
 * A child's `text_raw` is immutable, so the digest of the planned raw matn is the
 * child's identity across runs: the same narration keeps one row whatever its
 * position in the plan, and a changed matn is a different child rather than an
 * in-place rewrite of one. The key is derived from the raw text, never from the
 * ordinal or the cascade's group number, because both move when the fold or the
 * archive order changes.
 */

import { createHash } from "node:crypto";

/** The content key of one matn: the SHA-256 of its immutable raw text. */
export function matnKeyOf(rawMatn: string): string {
  return createHash("sha256").update(rawMatn, "utf8").digest("hex");
}
