import { describe, expect, it } from "vite-plus/test";
import {
  ESCAPED_BYTES_PER_CODE_POINT,
  stringLeaves,
  unboundedStringLeaves,
  worstCaseBodyBytes,
  type OpenApiSchema,
} from "./openapi-schema";

/**
 * The walk is the audit: a string leaf without a published length bound must
 * be observable, and the byte budget must be derived from the same bounds
 * rather than from a hand-maintained field list.
 */
describe("OpenAPI schema walk", () => {
  it("finds string leaves through unions, objects and nested variants", () => {
    const schema: OpenApiSchema = {
      anyOf: [
        { type: "object", properties: { id: { type: "string", maxLength: 3 } } },
        {
          type: "object",
          properties: { anchor: { oneOf: [{ type: "string", format: "uuid" }] } },
        },
      ],
    };
    expect(stringLeaves(schema).map((leaf) => leaf.path)).toEqual([
      "$.anyOf[0].properties.id",
      "$.anyOf[1].properties.anchor.oneOf[0]",
    ]);
  });

  it("reddens on a new unbounded string field", () => {
    const schema: OpenApiSchema = {
      type: "object",
      properties: {
        bounded: { type: "string", maxLength: 10 },
        id: { type: "string", format: "uuid" },
        literal: { const: "chain" },
        added: { type: "string" },
      },
    };
    expect(unboundedStringLeaves(schema, ["uuid"]).map((leaf) => leaf.path)).toEqual([
      "$.properties.added",
    ]);
    expect(() => worstCaseBodyBytes(schema, ["uuid"])).toThrow(/added/);
  });

  it("derives the escaped budget from maxLength plus the key envelope", () => {
    const schema: OpenApiSchema = {
      type: "object",
      properties: { a: { type: "string", maxLength: 2 } },
    };
    // Braces, the quoted key and colon, the value's quotes, and two code
    // points at the escaped worst case.
    expect(worstCaseBodyBytes(schema)).toBe(
      2 + JSON.stringify("a").length + 1 + 2 + 2 * ESCAPED_BYTES_PER_CODE_POINT,
    );
  });
});
