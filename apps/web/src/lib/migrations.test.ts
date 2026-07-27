import { describe, expect, it } from "vitest";
import { migrateToLatest, migrateV1ToV2 } from "./migrations";

describe("migrations", () => {
  it("upgrades v1 to v2", () => {
    const v2 = migrateV1ToV2({ schemaVersion: 1, notes: [] });
    expect(v2.schemaVersion).toBe(2);
  });

  it("migrateToLatest is idempotent at v2", () => {
    const s = migrateToLatest({ schemaVersion: 2, notes: [] });
    expect(s.schemaVersion).toBe(2);
  });
});
