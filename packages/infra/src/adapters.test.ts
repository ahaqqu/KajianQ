import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { createMemoryConfigStore } from "./config-store";
import { createS3ObjectStore } from "./object-store";
import { StoreError } from "@app/rag-core";

describe("infra adapters", () => {
  it("config store", async () => {
    const cfg = createMemoryConfigStore({ a: "1" });
    expect(await cfg.get("a")).toBe("1");
    await cfg.set("b", "2");
    expect(await cfg.get("b")).toBe("2");
  });
});

describe("S3ObjectStore (CLI-only adapter)", () => {
  const err = (name: string) => new S3ServiceException({ name, $fault: "client", $metadata: {} });

  it("classifies vendor exceptions via the sync mapper", async () => {
    const store = createS3ObjectStore(
      { send: () => Promise.reject(err("AccessDenied")) },
      "bucket",
    );
    const failure = await Effect.runPromise(store.put("k", "v").pipe(Effect.flip));
    expect(failure).toBeInstanceOf(StoreError);
    expect(failure.kind).toBe("config");
  });

  it("maps NoSuchKey to not_found", async () => {
    const store = createS3ObjectStore({ send: () => Promise.reject(err("NoSuchKey")) }, "bucket");
    const failure = await Effect.runPromise(store.get("k").pipe(Effect.flip));
    expect(failure.kind).toBe("not_found");
  });

  it("maps a payload-shape violation to constraint", async () => {
    const store = createS3ObjectStore(
      { send: () => Promise.reject(err("EntityTooLarge")) },
      "bucket",
    );
    const failure = await Effect.runPromise(store.put("k", "v").pipe(Effect.flip));
    expect(failure.kind).toBe("constraint");
  });

  it("destroys the body on mid-read failure (release path, C3)", async () => {
    let destroyed = false;
    const store = createS3ObjectStore(
      {
        send: () =>
          Promise.resolve({
            Body: {
              transformToByteArray: () => Promise.reject(new Error("socket closed")),
              destroy: () => {
                destroyed = true;
              },
            },
          }),
      },
      "bucket",
    );
    const failure = await Effect.runPromise(store.get("k").pipe(Effect.flip));
    expect(failure.kind).toBe("transport");
    expect(destroyed).toBe(true);
  });

  it("returns bytes on the success path", async () => {
    const store = createS3ObjectStore(
      {
        send: () =>
          Promise.resolve({
            Body: {
              transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])),
              destroy: () => {},
            },
          }),
      },
      "bucket",
    );
    const out = await Effect.runPromise(store.get("k"));
    expect(Array.from(out!)).toEqual([1, 2, 3]);
  });
});
