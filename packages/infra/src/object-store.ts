import { Effect } from "effect";
import { StoreError, type StoreErrorKind } from "@app/rag-core";

/**
 * ObjectStore — the blob persistence seam (ADR-0008), Effect-signatured
 * (ADR-0027 decision 7): every method returns `Effect<A, StoreError>` and
 * no error kind travels via `throw` across the seam. Holds raw source
 * archives and `text_raw` backups. Adapters (R2-bound, S3-compatible,
 * in-memory for tests) map vendor exceptions into `StoreError` kinds inside
 * the adapter — vendor types never appear in seam signatures.
 */
export interface ObjectStore {
  put(key: string, value: Uint8Array | string): Effect.Effect<void, StoreError>;
  get(key: string): Effect.Effect<Uint8Array | null, StoreError>;
  delete(key: string): Effect.Effect<void, StoreError>;
  list(prefix?: string): Effect.Effect<string[], StoreError>;
}

export { StoreError, type StoreErrorKind };

export function createMemoryObjectStore(): ObjectStore {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (v: Uint8Array | string) => (typeof v === "string" ? enc.encode(v) : v);

  return {
    put: (key, value) => Effect.sync(() => void map.set(key, toBytes(value))),
    get: (key) => Effect.sync(() => map.get(key) ?? null),
    delete: (key) => Effect.sync(() => void map.delete(key)),
    list: (prefix = "") => Effect.sync(() => [...map.keys()].filter((k) => k.startsWith(prefix))),
  };
}

export type R2Like = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
};

/**
 * Map a thrown R2-binding failure into the `StoreError` taxonomy (ADR-0027
 * decision 7). The Workers R2 binding throws plain `Error`s (vendor
 * exception classes are an S3-SDK concern, handled in the S3 adapter's own
 * mapper), so classification is message- and type-driven with a closed
 * default: anything unrecognized is `transport` — the caller's safest
 * retryable bucket — never silently dropped, and the original always rides
 * in `cause`.
 */
function toR2StoreError(cause: unknown): StoreError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed?\s?out|timeout|deadline|exceeded/i.test(message)) {
    return new StoreError({ kind: "timeout", cause });
  }
  if (/no such key|not found|doesn't exist|does not exist/i.test(message)) {
    return new StoreError({ kind: "not_found", cause });
  }
  return new StoreError({ kind: "transport", cause });
}

export function createR2ObjectStore(bucket: R2Like): ObjectStore {
  return {
    put: (key, value) =>
      Effect.tryPromise({
        try: () => bucket.put(key, value),
        catch: toR2StoreError,
      }).pipe(Effect.asVoid),
    get: (key) =>
      Effect.gen(function* () {
        const obj = yield* Effect.tryPromise({
          try: () => bucket.get(key),
          catch: toR2StoreError,
        });
        if (!obj) return null;
        // The body is a resource: consume it via acquireRelease so a
        // mid-read failure or interruption still runs the release path
        // (ADR-0027 decision 7 — download/upload streams release via
        // Scope). The binding exposes no explicit close, so release is a
        // best-effort detach that never masks the original failure.
        return yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => obj.arrayBuffer(),
            catch: toR2StoreError,
          }),
          (_buf, exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.sync(() => {
                  void obj;
                }),
        ).pipe(Effect.map((buf) => new Uint8Array(buf)));
      }).pipe(Effect.scoped),
    delete: (key) =>
      Effect.tryPromise({
        try: () => bucket.delete(key),
        catch: toR2StoreError,
      }).pipe(Effect.asVoid),
    list: (prefix = "") =>
      Effect.map(
        Effect.tryPromise({
          try: () => bucket.list({ prefix }),
          catch: toR2StoreError,
        }),
        (res) => res.objects.map((o) => o.key),
      ),
  };
}

export type S3Like = {
  send(command: unknown): Promise<unknown>;
};

/**
 * Map a thrown S3 SDK exception into the `StoreError` taxonomy
 * (ADR-0027 decision 7). Classification is exhaustive over the vendor's
 * observable failure surface with a closed default (`transport`) — the
 * `cause` always carries the original exception for audit. NoSuchKey and
 * timeouts map to their kinds; the 4xx-class names map to `config`
 * (credentials/bucket-naming/access — deterministic, fix-the-config) or
 * `constraint` (payload-shape — deterministic, fix-the-data); the S3 SDK
 * surfaces 5xx/credential-expiry as generic transport-level shapes, which
 * fall to the default.
 */
async function toS3StoreError(cause: unknown): Promise<StoreError> {
  const { S3ServiceException } = await import("@aws-sdk/client-s3");
  const name =
    cause instanceof S3ServiceException || cause instanceof Error ? cause.name : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (name === "NoSuchKey") {
    return new StoreError({ kind: "not_found", cause });
  }
  if (name === "RequestTimeout" || /\btimeout\b|timed?\s?out|deadline exceeded/i.test(message)) {
    return new StoreError({ kind: "timeout", cause });
  }
  if (cause instanceof S3ServiceException) {
    switch (name) {
      // Config-class: the store's wiring is wrong — same request fails
      // identically until the config changes.
      case "InvalidAccessKeyId":
      case "SignatureDoesNotMatch":
      case "InvalidBucketName":
      case "AccessDenied":
      case "BucketAlreadyExists":
        return new StoreError({ kind: "config", cause });
      // Constraint-class: the payload itself is invalid — deterministic.
      case "InvalidArgument":
      case "InvalidRequest":
      case "EntityTooLarge":
      case "MalformedACL":
        return new StoreError({ kind: "constraint", cause });
      default:
        break;
    }
  }
  return new StoreError({ kind: "transport", cause });
}

/** tryPromise over an S3 command; the async mapper keeps the SDK import dynamic. */
function s3Command<A>(run: () => Promise<A>): Effect.Effect<A, StoreError> {
  return Effect.tryPromise({
    try: () => toS3StoreErrorWith(run),
    catch: (c: unknown) =>
      c instanceof StoreError ? c : new StoreError({ kind: "transport", cause: c }),
  });
}

/** Run the command, letting the async mapper classify a thrown exception. */
async function toS3StoreErrorWith<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw await toS3StoreError(cause);
  }
}

/** Load the SDK command classes; a failed dynamic import is config-class. */
const importSdk = (): Effect.Effect<typeof import("@aws-sdk/client-s3"), StoreError> =>
  Effect.tryPromise({
    try: () => import("@aws-sdk/client-s3"),
    catch: (c) => new StoreError({ kind: "config", cause: c }),
  });

/**
 * Build an ObjectStore over the AWS S3 API (used for R2's S3-compatible
 * endpoint from a Bun CLI context, where the Worker's bound bucket is not
 * reachable). The `bucket` name and credentials come from config — this
 * adapter contains no account-specific defaults.
 */
export function createS3ObjectStore(client: S3Like, bucket: string): ObjectStore {
  return {
    put: (key, value) =>
      Effect.gen(function* () {
        const { PutObjectCommand } = yield* importSdk();
        yield* s3Command(() =>
          client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: value })),
        );
      }).pipe(Effect.asVoid),
    get: (key) =>
      Effect.gen(function* () {
        const { GetObjectCommand } = yield* importSdk();
        const res = yield* s3Command<{
          Body?: { transformToByteArray(): Promise<Uint8Array> } | undefined;
        } | null>(
          () =>
            client.send(new GetObjectCommand({ Bucket: bucket, Key: key })) as Promise<{
              Body?: { transformToByteArray(): Promise<Uint8Array> } | undefined;
            } | null>,
        );
        if (!res || !res.Body) return null;
        // The S3 body is a resource with a real release path: consume it
        // inside a Scope via acquireRelease, and on mid-read failure or
        // interruption call `destroy()` so the underlying socket is
        // released (ADR-0027 decision 7). NoSuchKey arrives as a failure
        // — mapped to `not_found` and surfaced, never swallowed.
        const body = res.Body;
        return yield* Effect.acquireRelease(
          s3Command(() => body.transformToByteArray()),
          (_bytes, exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.sync(() => {
                  const maybe = body as { destroy?: unknown };
                  if (typeof maybe.destroy === "function") maybe.destroy();
                }),
        );
      }).pipe(Effect.scoped),
    delete: (key) =>
      Effect.gen(function* () {
        const { DeleteObjectCommand } = yield* importSdk();
        yield* s3Command(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
      }).pipe(Effect.asVoid),
    list: (prefix = "") =>
      Effect.gen(function* () {
        const { ListObjectsV2Command } = yield* importSdk();
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
          const res = (yield* s3Command(() =>
            client.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
              }),
            ),
          )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string };
          for (const obj of res.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
          }
          continuationToken = res.NextContinuationToken;
        } while (continuationToken);
        return keys;
      }),
  };
}
