import { describe, expect, it } from "vitest";
import { dbToRow, noteToRow, rowToNote } from "./note-mapper";

describe("rowToNote", () => {
  it("normalizes deleted to a boolean", () => {
    const row = { id: "a", title: "t", body: "b", updatedAt: 1 };
    expect(rowToNote(row)).toEqual({ ...row, deleted: false });
    expect(rowToNote({ ...row, deleted: true }).deleted).toBe(true);
  });
});

describe("noteToRow", () => {
  it("carries all fields through", () => {
    const note = { id: "a", title: "t", body: "b", updatedAt: 1, deleted: false };
    expect(noteToRow(note)).toEqual(note);
  });
});

describe("dbToRow", () => {
  it("maps D1's 0/1 deleted flag to boolean", () => {
    const dbRow = { id: "a", title: "t", body: "b", updatedAt: 1, deleted: 1 };
    expect(dbToRow(dbRow).deleted).toBe(true);
    expect(dbToRow({ ...dbRow, deleted: 0 }).deleted).toBe(false);
  });
});
