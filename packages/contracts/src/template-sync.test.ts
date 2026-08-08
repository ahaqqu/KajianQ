import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  TemplateSyncManifestSchema,
  TemplateSyncStateSchema,
} from "./template-sync";

describe("TemplateSyncManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      upstream: "https://github.com/ahaqqu/agentic-project-template.git",
      overwrite: [".agents/", ".github/workflows/"],
      merge: ["apps/", "packages/"],
    };
    expect(v.parse(TemplateSyncManifestSchema, manifest)).toEqual(manifest);
  });

  it("rejects an empty upstream", () => {
    expect(() =>
      v.parse(TemplateSyncManifestSchema, {
        upstream: "",
        overwrite: [],
        merge: [],
      }),
    ).toThrow();
  });

  it("rejects non-string paths", () => {
    expect(() =>
      v.parse(TemplateSyncManifestSchema, {
        upstream: "https://example.com/repo.git",
        overwrite: [".agents/", 123],
        merge: [],
      }),
    ).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() =>
      v.parse(TemplateSyncManifestSchema, { upstream: "https://example.com" }),
    ).toThrow();
  });
});

describe("TemplateSyncStateSchema", () => {
  it("accepts a valid state", () => {
    const state = { ref: "v1.0.0", commit: "abc123" };
    expect(v.parse(TemplateSyncStateSchema, state)).toEqual(state);
  });

  it("rejects an empty ref", () => {
    expect(() => v.parse(TemplateSyncStateSchema, { ref: "", commit: "abc" })).toThrow();
  });
});
