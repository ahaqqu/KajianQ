import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

describe("openApiDocument", () => {
  it("includes health and sync", () => {
    const doc = openApiDocument();
    expect(doc.paths["/v1/health"]).toBeTruthy();
    expect(doc.paths["/v1/sync"]).toBeTruthy();
  });
});
