/**
 * snapshot-store.mjs — the ObjectStore plumbing for the corpus-snapshot CLI
 * (ADR-0038). Split out of `db-snapshot.mjs` for the same reason
 * `archive-store.mjs` is split out of the ingest CLIs: the CLI entry point
 * stays a thin composition root and its import count stays under the
 * agentic-limits cap.
 *
 * Repo rule for CLIs (archive-store.mjs): the script never touches the S3 SDK
 * or `env.*` directly — this module reads the R2 credential env vars and all
 * storage I/O goes through the `@app/infra` ObjectStore seam (Effect-shaped,
 * ADR-0027 decision 7).
 *
 * Layout in the staging bucket, one directory per snapshot label:
 *
 *   snapshots/<label>/kajianq-<label>.dump   pg_dump custom-format archive
 *   snapshots/<label>/manifest.json          provenance + integrity record
 *
 * Labels are never overwritten: `db-snapshot.mjs create` refuses a label that
 * already has a manifest, so a snapshot can only be superseded by a new label.
 */
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { Effect } from "effect";
import { createS3ObjectStore } from "@app/infra";

/** Root prefix for every snapshot object in the bucket. */
export const SNAPSHOT_ROOT = "snapshots";

export const snapshotPrefix = (label) => `${SNAPSHOT_ROOT}/${label}`;
export const dumpKey = (label) => `${snapshotPrefix(label)}/kajianq-${label}.dump`;
export const manifestKey = (label) => `${snapshotPrefix(label)}/manifest.json`;

/**
 * Build the ObjectStore from the R2 env. Throws (never returns null) when a
 * credential is missing: a snapshot that silently stores nothing is exactly
 * the failure this tool exists to prevent — the ingest CLIs may skip
 * archiving with a warning, but a backup must never be a no-op.
 */
export function createSnapshotStore(env = process.env) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_STAGING ?? "kajianq-raw-staging";

  const pairs = [
    ["R2_ACCOUNT_ID", accountId],
    ["R2_ACCESS_KEY_ID", accessKeyId],
    ["R2_SECRET_ACCESS_KEY", secretAccessKey],
  ];
  const missing = pairs.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `snapshot store is not configured — missing ${missing.join(", ")}. ` +
        `Refusing to continue: a snapshot must never be a silent no-op.`,
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { store: createS3ObjectStore(client, bucket), bucket };
}

/** Put an object through the seam; resolves when the write is acknowledged. */
export const putObject = (store, key, value) => Effect.runPromise(store.put(key, value));

/**
 * Get an object through the seam, mapping a missing key to `null`.
 *
 * The `not_found` kind is a *failure* on the seam (`object-store.ts` maps
 * NoSuchKey to `StoreError{kind:"not_found"}` and surfaces it rather than
 * returning null), so absence is handled inside Effect with `catchTag` — the
 * rejected promise is a FiberFailure wrapper, and reading `.kind` off it does
 * not work.
 */
export const getObject = (store, key) =>
  Effect.runPromise(
    store
      .get(key)
      .pipe(
        Effect.catchTag("StoreError", (err) =>
          err.kind === "not_found" ? Effect.succeed(null) : Effect.fail(err),
        ),
      ),
  );

/** List object keys under a prefix (defaults to the snapshot root). */
export const listObjects = (store, prefix = SNAPSHOT_ROOT) => Effect.runPromise(store.list(prefix));

/**
 * Content hash of a stored artifact, recorded in the manifest and re-checked on
 * every `verify`. This is what turns "we have a backup" into a checkable claim.
 */
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
