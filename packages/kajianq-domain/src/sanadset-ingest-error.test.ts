import { describe, expect, it } from "vite-plus/test";
import { StoreError } from "@app/infra";
import { describeIngestError } from "./sanadset-ingest-error";

/**
 * Test intent, named before the assertions:
 * - trap: a `StoreError` has an empty `message`, so printing `error.message` would
 *   show the operator nothing. The description must carry the kind and the cause,
 *   including the Postgres SQLSTATE when the driver supplied one — the missing
 *   migration case must name the undefined relation, not "StoreError";
 * - trap: a cause the adapter could not wrap must still produce text, never a blank
 *   line, and a nested driver error must not be swallowed.
 */

describe("describing an ingest failure", () => {
  it("names a StoreError's kind and the failing cause", () => {
    const missing = Object.assign(new Error('relation "narrators" does not exist'), {
      code: "42P01",
    });
    expect(describeIngestError(new StoreError({ kind: "config", cause: missing }))).toBe(
      'StoreError (config): relation "narrators" does not exist (code 42P01)',
    );
  });

  it("never returns an empty description", () => {
    expect(describeIngestError(new StoreError({ kind: "constraint", cause: undefined }))).toBe(
      "StoreError (constraint): no cause",
    );
    expect(describeIngestError(new StoreError({ kind: "timeout", cause: 42 }))).toBe(
      "StoreError (timeout): 42",
    );
    expect(describeIngestError(new Error(""))).toBe("Error");
    expect(describeIngestError("boom")).toBe("boom");
    expect(describeIngestError(undefined)).toBe("no cause");
  });

  it("walks a nested cause chain", () => {
    const inner = new Error("connection refused");
    const outer = new Error("could not acquire a client", { cause: inner });
    expect(describeIngestError(new StoreError({ kind: "transport", cause: outer }))).toBe(
      "StoreError (transport): could not acquire a client — caused by: connection refused",
    );
  });
});
