import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { migrateDownV2ToV1, migrateV1ToV2 } from "./migrations";

test.prop([
  fc.array(
    fc.record({
      id: fc.uuid(),
      title: fc.string({ minLength: 1, maxLength: 20 }),
      body: fc.string({ maxLength: 40 }),
      updatedAt: fc.nat(),
      deleted: fc.option(fc.constant(true), { nil: undefined }),
    }),
    { maxLength: 15 },
  ),
])("migration round-trip preserves notes", (notes) => {
  const v1 = { schemaVersion: 1 as const, notes };
  const v2 = migrateV1ToV2(v1);
  const back = migrateDownV2ToV1(v2);
  expect(back.notes).toEqual(notes);
});
