import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { aliveNotes, type NoteRow } from "./merge";
import { gcTombstones } from "./tombstones";

const rowArb: fc.Arbitrary<NoteRow> = fc.record({
  id: fc.constantFrom("a", "b", "c", "d"),
  title: fc.string({ maxLength: 8 }),
  body: fc.string({ maxLength: 16 }),
  updatedAt: fc.nat({ max: 10_000_000 }),
  deleted: fc.option(fc.boolean(), { nil: undefined }),
});

test.prop([
  fc.array(rowArb, { maxLength: 20 }),
  fc.nat({ max: 20_000_000 }),
])("GC never loses alive rows", (rows, now) => {
  expect(aliveNotes(gcTombstones(rows, now))).toEqual(aliveNotes(rows));
});

test.prop([
  fc.array(rowArb, { maxLength: 20 }),
  fc.nat({ max: 20_000_000 }),
])("GC never resurrects rows — output is a subset of input", (rows, now) => {
  const out = gcTombstones(rows, now);
  expect(out.length).toBeLessThanOrEqual(rows.length);
  for (const row of out) expect(rows).toContain(row);
});
