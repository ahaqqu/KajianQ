import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { FeedbackRequestSchema } from "./feedback";
import { describeIssue, issuePath } from "./issue-path";

/**
 * `issuePath` turns a valibot issue's PathItem OBJECTS into a dotted field
 * path for a validation diagnostic (#271, #283), and `describeIssue` composes
 * that path with the issue's message into the one `field: message` template
 * every call site renders. These are trap tests: the defect they exist to
 * prevent is a diagnostic that names no field at all, so every row asserts
 * the rendered FIELD NAME, not merely that the function returned a string.
 *
 * Mutation that reddens every field-naming row: replace the `key`-reading map
 * with `(path ?? []).join(".")`, which stringifies each PathItem object as
 * `[object Object]`. Mutation that reddens the union rows specifically: drop
 * `mostSpecificIssue`'s nested-issue descent, which reverts a `v.union`
 * failure to the path-less `<body>: …` it reported before this fix.
 */
describe("issuePath", () => {
  it("renders an object property as its field name", () => {
    expect(issuePath([{ key: "sessionId" }])).toBe("sessionId");
  });

  it("renders a nested path, including array indices", () => {
    expect(issuePath([{ key: "questions" }, { key: 0 }, { key: "citations" }])).toBe(
      "questions.0.citations",
    );
  });

  it("never stringifies a PathItem object", () => {
    const rendered = issuePath([{ key: "rating" }]);
    expect(rendered).toContain("rating");
    expect(rendered).not.toContain("[object Object]");
  });

  it("states <body> for an absent, empty, or unnameable path", () => {
    expect(issuePath(undefined)).toBe("<body>");
    expect(issuePath([])).toBe("<body>");
    // A path item with no string/number key names nothing; it is dropped
    // rather than rendered as `undefined` or `[object Object]`.
    expect(issuePath([{} as { key?: unknown }, { key: "id" }])).toBe("id");
    expect(issuePath([{} as { key?: unknown }])).toBe("<body>");
    // An empty-string key names nothing either: rendering it produced the
    // bare prefix `": message"`, not a field (thermo A1, latent).
    expect(issuePath([{ key: "" }])).toBe("<body>");
    expect(issuePath([{ key: "a" }, { key: "" }, { key: "b" }])).toBe("a.b");
  });
});

/**
 * `describeIssue` is the union case's fix (thermo-review A1): the feedback
 * body's `v.union` reports ONE path-less issue whose nested `issues` carry the
 * real paths, so the descent — not a contract change — is what makes the
 * diagnostic name a field. These rows run the REAL parser on the REAL
 * malformed bodies, so they fail if either half regresses.
 */
describe("describeIssue", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";

  it("renders a path-bearing issue as `field: message` (unchanged output)", () => {
    expect(
      describeIssue({ path: [{ key: "messageId" }], message: 'Invalid UUID: Received "msg1"' }),
    ).toBe('messageId: Invalid UUID: Received "msg1"');
  });

  it("states <body> for a leaf issue that names no field", () => {
    expect(describeIssue({ message: "Invalid type: Expected Object but received string" })).toBe(
      "<body>: Invalid type: Expected Object but received string",
    );
  });

  it("names the field a union failure hides in its nested issues", () => {
    const parsed = v.safeParse(FeedbackRequestSchema, { messageId: uuid, rating: "meh" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const detail = parsed.issues.map(describeIssue).join("; ");
    expect(detail).toBe('rating: Invalid type: Expected ("up" | "down") but received "meh"');
    expect(detail).not.toContain("<body>");
  });

  it("surfaces the deepest nested issue, not the first branch's noise", () => {
    // The thumb branch's "rating is missing" is emitted FIRST, but this body
    // is a flag whose real defect is the anchor's category pairing — the
    // deeper `anchor.category` issue. "First path-bearing" would blame rating.
    const parsed = v.safeParse(FeedbackRequestSchema, {
      messageId: uuid,
      anchor: { type: "grade", category: "irrelevant_chunk", id: "c1" },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const detail = parsed.issues.map(describeIssue).join("; ");
    expect(detail).toContain("anchor.category");
    expect(detail).not.toContain("rating");
  });

  it("keeps <body> when no nested issue names a field", () => {
    const parsed = v.safeParse(FeedbackRequestSchema, "nope");
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.issues.map(describeIssue).join("; ")).toBe(
      '<body>: Invalid type: Expected Object but received "nope"',
    );
  });
});
