import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { aliveNotes, mergeNotes, type NoteRow } from "./merge";

const rowArb: fc.Arbitrary<NoteRow> = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1, maxLength: 32 }),
  body: fc.string({ maxLength: 64 }),
  updatedAt: fc.nat({ max: 1_000_000 }),
  deleted: fc.option(fc.constant(true), { nil: undefined }),
});

test.prop([fc.array(rowArb, { maxLength: 20 })])("merge is idempotent", (rows) => {
  const once = mergeNotes([], rows);
  expect(mergeNotes(once, rows)).toEqual(once);
});

test.prop([
  fc.array(rowArb, { maxLength: 10 }),
  fc.array(rowArb, { maxLength: 10 }),
])("merge is commutative", (a, b) => {
  const sort = (xs: NoteRow[]) =>
    [...xs].sort((x, y) => x.id.localeCompare(y.id));
  expect(sort(mergeNotes(a, b))).toEqual(sort(mergeNotes(b, a)));
});

test.prop([rowArb])("delete beats concurrent update", (row) => {
  const live: NoteRow = {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt,
  };
  const update: NoteRow = {
    ...live,
    title: `${live.title}-u`,
    updatedAt: live.updatedAt + 1,
  };
  const del: NoteRow = { ...live, deleted: true, updatedAt: live.updatedAt + 2 };
  expect(aliveNotes(mergeNotes([update], [del])).find((r) => r.id === row.id)).toBeUndefined();
});
