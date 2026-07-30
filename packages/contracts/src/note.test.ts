import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { NoteSchema } from "./note";

describe("NoteSchema", () => {
  it("accepts valid note", () => {
    const r = v.safeParse(NoteSchema, {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Hello",
      body: "World",
      updatedAt: 1,
      deleted: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty title", () => {
    const r = v.safeParse(NoteSchema, {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "",
      body: "World",
      updatedAt: 1,
      deleted: false,
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-uuid id", () => {
    const r = v.safeParse(NoteSchema, {
      id: "not-a-uuid",
      title: "Hello",
      body: "World",
      updatedAt: 1,
      deleted: false,
    });
    expect(r.success).toBe(false);
  });
});
