export interface ObjectStore {
  put(key: string, value: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function createMemoryObjectStore(): ObjectStore {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (v: Uint8Array | string) =>
    typeof v === "string" ? enc.encode(v) : v;

  return {
    async put(key, value) {
      map.set(key, toBytes(value));
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix = "") {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

export type R2Like = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
};

export function createR2ObjectStore(bucket: R2Like): ObjectStore {
  return {
    async put(key, value) {
      await bucket.put(key, value);
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix = "") {
      const res = await bucket.list({ prefix });
      return res.objects.map((o) => o.key);
    },
  };
}

export type S3Like = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<unknown>;
};

/**
 * Build an ObjectStore over the AWS S3 API (used for R2's S3-compatible
 * endpoint from a Bun CLI context, where the Worker's bound bucket is not
 * reachable). The `bucket` name and credentials come from config — this
 * adapter contains no account-specific defaults.
 */
export function createS3ObjectStore(client: S3Like, bucket: string): ObjectStore {
  return {
    async put(key, value) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: value,
        }),
      );
    },
    async get(key) {
      const { GetObjectCommand, S3ServiceException } = await import("@aws-sdk/client-s3");
      try {
        const res = (await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
        if (!res.Body) return null;
        return await res.Body.transformToByteArray();
      } catch (err) {
        if (err instanceof S3ServiceException && err.name === "NoSuchKey") {
          return null;
        }
        throw err;
      }
    },
    async delete(key) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix = "") {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const res = (await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string };
        for (const obj of res.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = res.NextContinuationToken;
      } while (continuationToken);
      return keys;
    },
  };
}
