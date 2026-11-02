import { ChatErrorSchema } from "@app/contracts";
import { describe, expect, it } from "vite-plus/test";
import { BODY_MAX_BYTES, REJECTION_STATUS, type BodyRejectionCode } from "./body";
import { bodyRejectionResponses } from "./body-openapi";

/**
 * The published side of the body boundary: one factory, driven by the code and
 * status map, so the document cannot state a contract the map does not hold.
 */

describe("bodyRejectionResponses", () => {
  it("documents every rejection code under the status the map assigns", () => {
    // A code added to the map is documented by construction; this row is what
    // makes that true for its status key as well as its prose.
    const responses = bodyRejectionResponses(ChatErrorSchema);
    for (const code of Object.keys(REJECTION_STATUS) as BodyRejectionCode[]) {
      const status = REJECTION_STATUS[code];
      expect(responses[status].description, code).toContain(code);
    }
  });

  it("interpolates the ceiling into the 413 description", () => {
    const responses = bodyRejectionResponses(ChatErrorSchema);
    expect(responses[413].description).toContain(`${BODY_MAX_BYTES}-byte`);
    expect(responses[413].description).toContain("payload_too_large");
  });
});
