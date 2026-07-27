import { describe, expect, it } from "vitest";
import { NoteInputSchema, NoteSchema } from "./note";

describe("NoteSchema", () => {
  it("accepts valid note", () => {
    const r = NoteSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Hello",
      body: "World",
      updatedAt: 1,
      deleted: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty title on input", () => {
    expect(NoteInputSchema.safeParse({ title: "" }).success).toBe(false);
  });
});
