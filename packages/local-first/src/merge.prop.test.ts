import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { aliveNotes, mergeNotes, type NoteRow } from "./merge";

/**
 * Small id and updatedAt pools force same-id collisions and exact-timestamp
 * ties — the cases where LWW merge law violations hide.
 */
const rowArb: fc.Arbitrary<NoteRow> = fc.record({
  id: fc.constantFrom("a", "b", "c", "d"),
  title: fc.string({ minLength: 1, maxLength: 8 }),
  body: fc.string({ maxLength: 16 }),
  updatedAt: fc.integer({ min: 0, max: 5 }),
  deleted: fc.option(fc.boolean(), { nil: undefined }),
});

const rowsArb = fc.array(rowArb, { maxLength: 12 });

const byId = (xs: NoteRow[]) =>
  [...xs].sort((x, y) => x.id.localeCompare(y.id));

test.prop([rowsArb])("merge is idempotent", (rows) => {
  const once = mergeNotes([], rows);
  expect(mergeNotes(once, rows)).toEqual(once);
});

test.prop([rowsArb, rowsArb])(
  "merge is commutative, including exact-timestamp ties",
  (a, b) => {
    expect(byId(mergeNotes(a, b))).toEqual(byId(mergeNotes(b, a)));
  },
);

test.prop([rowsArb, rowsArb, rowsArb])("merge is associative", (a, b, c) => {
  const left = byId(mergeNotes(mergeNotes(a, b), c));
  const right = byId(mergeNotes(a, mergeNotes(b, c)));
  expect(left).toEqual(right);
});

test.prop([rowsArb, rowsArb])("delete wins once seen", (a, b) => {
  const merged = mergeNotes(a, b);
  for (const row of [...a, ...b]) {
    if (row.deleted === true) {
      const winner = merged.find((r) => r.id === row.id);
      expect(winner?.deleted).toBe(true);
    }
  }
});

test.prop([fc.uuid(), fc.string({ minLength: 1 }), fc.nat()])(
  "delete beats concurrent update",
  (id, title, updatedAt) => {
    const update: NoteRow = { id, title: `${title}-u`, body: "", updatedAt: updatedAt + 1 };
    const del: NoteRow = { id, title, body: "", updatedAt: updatedAt + 2, deleted: true };
    expect(
      aliveNotes(mergeNotes([update], [del])).find((r) => r.id === id),
    ).toBeUndefined();
  },
);
