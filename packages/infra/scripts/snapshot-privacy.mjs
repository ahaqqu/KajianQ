/**
 * snapshot-privacy.mjs — the archive's privacy posture (ADR-0043 decision 5),
 * extracted from `db-snapshot.mjs` so the CLI stays a thin composition root and
 * inside the agentic-limits line cap (same reason `pg-conn.mjs` and
 * `snapshot-store.mjs` were split out).
 *
 * A `db:snapshot` archive is a whole-database `pg_dump`, so it carries personal
 * data whenever the chat/session/trace/feedback tables hold a row. ADR-0043
 * decision 5 requires that be written down rather than assumed, and that an
 * archive carrying personal data be encrypted at rest before personal data
 * lands on the VPS — without inventing a second snapshot tool (the encrypted
 * path is the GDPR-D backup tooling, `provision/vps/backup/`).
 *
 * The decision is therefore three-valued, and each value says exactly what was
 * asserted:
 *   - `encrypted`   — the operator asserted the target is encrypted at rest;
 *   - `acknowledged`— the operator asserted the *opposite* and accepted the
 *                     recorded transitional exposure (the R2 prefix today);
 *   - `refused`     — neither was asserted, so the archive must not be written.
 * A caller that treats `refused` as a warning would defeat the whole point, so
 * it is a distinct value rather than a boolean.
 */
import { carriesPersonalData } from "./pg-conn.mjs";

/** The two environment flags an operator asserts, and nothing else, sets them. */
export const ENCRYPTED_FLAG = "KAJIANQ_SNAPSHOT_ENCRYPTED_AT_REST";
export const PLAINTEXT_FLAG = "KAJIANQ_SNAPSHOT_PLAINTEXT_ACKNOWLEDGED";

/** A boolean environment flag: absent/empty/false → false, 1/true → true. */
export function parseFlag(raw) {
  return /^(1|true)$/i.test((raw ?? "").trim());
}

/**
 * Classify one snapshot's privacy posture from its row counts and the
 * operator's assertions. `posture` is `none` for an archive with no
 * personal-data rows (the one case where neither assertion is needed).
 */
export function archivePrivacy(counts, env = {}) {
  const personalData = carriesPersonalData(counts);
  const encryptedAtRest = parseFlag(env[ENCRYPTED_FLAG]);
  const plaintextAcknowledged = parseFlag(env[PLAINTEXT_FLAG]);
  let posture = "none";
  if (personalData) {
    if (encryptedAtRest) posture = "encrypted";
    else if (plaintextAcknowledged) posture = "acknowledged";
    else posture = "refused";
  }
  return { personalData, encryptedAtRest, plaintextAcknowledged, posture };
}

/** The refusal message for a posture of `refused`, naming both escapes. */
export function refusalMessage(label) {
  return (
    `snapshot "${label}" would carry personal data (users/sessions/chat/traces/feedback) ` +
    `and neither storage posture was asserted. ADR-0043 decision 5: an archive carrying ` +
    `personal data must be encrypted at rest before personal data lands on the VPS. ` +
    `Either route it through the GDPR-D encrypted path ` +
    `(provision/vps/backup/kajianq-backup.mjs — restic client-side encryption; do NOT invent ` +
    `a second snapshot tool), or, when the target is genuinely encrypted at rest, set ` +
    `${ENCRYPTED_FLAG}=true. If the target is NOT encrypted (the R2 transitional exposure ` +
    `ADR-0043 decision 5 records), set ${PLAINTEXT_FLAG}=true and cite that decision in the PR.`
  );
}

/** The one-line privacy banner `create` prints for a written archive. */
export function privacyBanner(privacy) {
  if (!privacy.personalData) return "  privacy   no personal-data rows in this snapshot";
  return privacy.posture === "encrypted"
    ? "  privacy   CARRYING PERSONAL DATA — encrypted at rest (ADR-0043 d5)"
    : "  privacy   CARRYING PERSONAL DATA — plaintext, acknowledged exposure (ADR-0043 d5)";
}

/**
 * Build a snapshot manifest. Lives here rather than in the CLI because the
 * manifest now carries the privacy block, so the two must move together — a
 * manifest written without it would be exactly the unexamined archive ADR-0043
 * decision 5 forbids. `dump`/`source`/`git` are passed in: they are the CLI's
 * own facts.
 */
export function buildManifest({ label, createdAt, tool, git, source, dump, counts, privacy }) {
  return {
    label,
    createdAt,
    tool,
    git,
    source,
    dump,
    tableCounts: counts,
    privacy: {
      carriesPersonalData: privacy.personalData,
      encryptedAtRest: privacy.encryptedAtRest,
      plaintextAcknowledged: privacy.plaintextAcknowledged,
    },
  };
}
