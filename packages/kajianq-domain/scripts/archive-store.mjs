/**
 * archive-store.mjs — R2 raw-source archival + source-acquisition re-export
 * for the ingest CLIs (issues #6, #7). (One CLI-side I/O module keeps the
 * composition root's import count within the agentic-limits cap.)
 *
 * Builds an ObjectStore adapter over R2's S3-compatible endpoint (A2: the
 * CLI never touches the S3 SDK or `env.*` directly — this module reads the
 * R2 credential env vars so the caller stays a thin composition root, and
 * all storage I/O goes through the `@app/infra` ObjectStore seam). When the
 * credentials are absent the archive step is skipped and reported, never
 * silently faked.
 */
import { S3Client } from "@aws-sdk/client-s3";

export { acquireFiles, acquireSources, resolveFromCwd } from "./source-acquisition.mjs";

/**
 * Build the archive ObjectStore from the R2 env credentials, or null when
 * they are absent (the caller reports `archiveStored: false`).
 */
export function createArchiveObjectStore(createS3ObjectStore) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_STAGING ?? "kajianq-raw-staging";

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return createS3ObjectStore(client, bucket);
}

/**
 * Archive the raw source texts under a fingerprinted prefix and return the
 * archive provenance (`stored`, `keys`, `prefix`) for the IngestionReport.
 * `sources.editionFiles` (hadith runs) is an optional list of
 * `[cacheFile, text]` pairs archived alongside the Quran-shaped fields.
 */
export async function archiveRawSources({ sources, store, prefix, bundle, archiveFingerprint, log }) {
  if (!store) {
    log.warn("R2 credentials absent — raw archive NOT stored", { archiveStored: false });
    return { stored: false, keys: [] };
  }

  const fingerprint = archiveFingerprint(bundle);
  const keyPrefix = `${prefix}/${fingerprint}`;
  const puts = [
    [`${keyPrefix}/surah_list.json`, sources.surahListText],
    [`${keyPrefix}/morphology.txt`, sources.morphologyText],
    ...sources.surahFiles.map((text, i) => [`${keyPrefix}/Surah/${i + 1}.json`, text]),
    ...(sources.editionFiles ?? []).map(([name, text]) => [`${keyPrefix}/editions/${name}`, text]),
  ];

  for (const [key, body] of puts) {
    await store.put(key, body);
  }
  log.info("archived raw source object(s)", { count: puts.length, prefix: keyPrefix });
  return { stored: true, keys: puts.map(([key]) => key), prefix: keyPrefix };
}