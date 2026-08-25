import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import type { Note } from "@app/contracts";
import type { NoteRow } from "./merge";
import { noteToRow, rowToNote } from "./note-mapper";

const rowArb: fc.Arbitrary<NoteRow> = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1, maxLength: 32 }),
  body: fc.string({ maxLength: 64 }),
  updatedAt: fc.nat(),
  deleted: fc.option(fc.boolean(), { nil: undefined }),
});

const noteArb: fc.Arbitrary<Note> = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1, maxLength: 32 }),
  body: fc.string({ maxLength: 64 }),
  updatedAt: fc.nat(),
  deleted: fc.boolean(),
});

test.prop([rowArb])("noteToRow ∘ rowToNote is identity modulo deleted normalization", (row) => {
  expect(noteToRow(rowToNote(row))).toEqual({
    ...row,
    deleted: Boolean(row.deleted),
  });
});

test.prop([noteArb])("rowToNote ∘ noteToRow is exact identity", (note) => {
  expect(rowToNote(noteToRow(note))).toEqual(note);
});
