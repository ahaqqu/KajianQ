import { describe, expect, it } from "vitest";
import { issuePath } from "./issue-path";

/**
 * `issuePath` turns a valibot issue's PathItem OBJECTS into a dotted field
 * path for a validation diagnostic (#271, #283). These are trap tests: the
 * defect it exists to prevent is a diagnostic that names no field at all, so
 * every row asserts the rendered FIELD NAME, not merely that the function
 * returned a string.
 *
 * Mutation that reddens every field-naming row: replace the `key`-reading map
 * with `(path ?? []).join(".")`, which stringifies each PathItem object as
 * `[object Object]`.
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
  });
});
