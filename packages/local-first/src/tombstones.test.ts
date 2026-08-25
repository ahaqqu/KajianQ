import { describe, expect, it } from "vitest";
import type { NoteRow } from "./merge";
import { TOMBSTONE_TTL_MS, gcTombstones, toTombstone } from "./tombstones";

describe("toTombstone", () => {
  it("strips the payload — a delete retains no content", () => {
    expect(toTombstone("n1", 42)).toEqual({
      id: "n1",
      title: "",
      body: "",
      updatedAt: 42,
      deleted: true,
    });
  });
});

describe("gcTombstones", () => {
  const now = 1_000_000_000_000;

  it("drops tombstones older than the horizon", () => {
    const old = toTombstone("old", now - TOMBSTONE_TTL_MS - 1);
    expect(gcTombstones([old], now)).toEqual([]);
  });

  it("keeps tombstones inside the horizon", () => {
    const recent = toTombstone("recent", now - TOMBSTONE_TTL_MS + 1);
    expect(gcTombstones([recent], now)).toEqual([recent]);
  });

  it("drops a tombstone exactly at the horizon", () => {
    const edge = toTombstone("edge", now - TOMBSTONE_TTL_MS);
    expect(gcTombstones([edge], now)).toEqual([]);
  });

  it("keeps future-dated tombstones (fast client clock)", () => {
    const future = toTombstone("future", now + 60_000);
    expect(gcTombstones([future], now)).toEqual([future]);
  });

  it("never touches alive rows, however old", () => {
    const alive: NoteRow = {
      id: "alive",
      title: "x",
      body: "y",
      updatedAt: 1,
    };
    expect(gcTombstones([alive], now)).toEqual([alive]);
  });
});
