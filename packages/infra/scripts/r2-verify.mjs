#!/usr/bin/env bun
/**
 * r2-verify.mjs — verify the R2 bucket is readable/writable from the
 * ingestion CLI environment (#4 AC), using S3-compatible credentials from
 * local env vars, not the Worker's bound bucket.
 *
 *   R2_ACCOUNT_ID=… \
 *   R2_ACCESS_KEY_ID=… \
 *   R2_SECRET_ACCESS_KEY=… \
 *   R2_BUCKET_STAGING=kajianq-raw-staging \
 *   bun packages/infra/scripts/r2-verify.mjs
 *
 * put → get → list → delete round-trip on a throwaway key under
 * `infra-verify/` in the staging bucket, cleaned up at the end.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_STAGING ?? "kajianq-raw-staging";

for (const [name, value] of [
  ["R2_ACCOUNT_ID", ACCOUNT_ID],
  ["R2_ACCESS_KEY_ID", ACCESS_KEY],
  ["R2_SECRET_ACCESS_KEY", SECRET_KEY],
]) {
  if (!value) {
    console.error(`r2-verify: ${name} is not set`);
    process.exit(1);
  }
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

const key = `infra-verify/${Date.now().toString(36)}.txt`;
const marker = `verify-${Date.now().toString(36)}`;

await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: marker }));
console.log(`r2-verify: wrote   ${key}`);

const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
const text = await got.Body.transformToString();
if (text !== marker) {
  console.error(`r2-verify: read mismatch (expected ${marker}, got ${text})`);
  process.exit(1);
}
console.log(`r2-verify: read    OK`);

const listed = await client.send(
  new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "infra-verify/" }),
);
console.log(
  `r2-verify: listed  ${(listed.Contents ?? []).length} key(s) under infra-verify/`,
);

await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
console.log(`r2-verify: deleted ${key}`);
console.log(`r2-verify: bucket "${BUCKET}" is readable/writable ✓`);
