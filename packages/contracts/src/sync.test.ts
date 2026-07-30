import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  SyncRequestSchema,
  SyncResponseSchema,
  type SyncRequest,
  type SyncResponse,
} from "./sync";

const aliveNote = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  title: "Hello",
  body: "World",
  updatedAt: 1,
  deleted: false,
};

/** Deleted notes sync as payload-stripped tombstones (local-first toTombstone). */
const tombstone = {
  id: "660e8400-e29b-41d4-a716-446655440000",
  title: "",
  body: "",
  updatedAt: 2,
  deleted: true,
};

describe("SyncRequestSchema", () => {
  it("accepts a request mixing alive notes and stripped tombstones", () => {
    const r = v.safeParse(SyncRequestSchema, {
      schemaVersion: 2,
      clientVersion: "0.1.0",
      notes: [aliveNote, tombstone],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing clientVersion", () => {
    const r = v.safeParse(SyncRequestSchema, {
      schemaVersion: 2,
      notes: [aliveNote],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-integer schemaVersion", () => {
    const r = v.safeParse(SyncRequestSchema, {
      schemaVersion: 2.5,
      clientVersion: "0.1.0",
      notes: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("SyncResponseSchema", () => {
  it("rejects a response without serverNow (clock discipline field)", () => {
    const r = v.safeParse(SyncResponseSchema, {
      schemaVersion: 2,
      notes: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("sync contract round-trip (locale-independent)", () => {
  it("request and response shapes survive v.parse unchanged", () => {
    const request: SyncRequest = {
      schemaVersion: 2,
      clientVersion: "0.1.0",
      notes: [aliveNote, tombstone],
    };
    expect(v.parse(SyncRequestSchema, request)).toEqual(request);

    const response: SyncResponse = {
      schemaVersion: 2,
      serverNow: 1_750_000_000_000,
      notes: [aliveNote],
    };
    expect(v.parse(SyncResponseSchema, response)).toEqual(response);
  });
});
