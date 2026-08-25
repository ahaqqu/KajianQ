import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  compileRules,
  sourceLineViolations,
  dependencyViolations,
} from "../../scripts/check-boundary.mjs";

const RULES = compileRules();
const CLI = resolve(process.cwd(), "scripts/check-boundary.mjs");

describe("boundary gate rules", () => {
  it("compiles every JSON rule into a RegExp", () => {
    expect(RULES.length).toBe(3);
    for (const r of RULES) {
      expect(r.regex).toBeInstanceOf(RegExp);
      expect(typeof r.name).toBe("string");
      expect(Array.isArray(r.exts)).toBe(true);
    }
  });

  describe("#41 — word-boundary anchors avoid false-positive landmines", () => {
    // Each pair is checked as a .ts source line so the exts filter applies.
    const file = "packages/rag-core/src/sample.ts";

    it("does not flag 'hasAnnotation' (substring of 'hasan')", () => {
      expect(
        sourceLineViolations("function hasAnnotation(x: string) {}", file, RULES),
      ).toEqual([]);
    });

    it("does not flag 'chasan' (substring of 'hasan')", () => {
      expect(sourceLineViolations("const chasan = 1;", file, RULES)).toEqual([]);
    });

    it("does not flag common build-tool identifiers ('webpack', 'postcss')", () => {
      expect(
        sourceLineViolations("import webpack from 'webpack';", file, RULES),
      ).toEqual([]);
      expect(
        sourceLineViolations("import postcss from 'postcss';", file, RULES),
      ).toEqual([]);
    });

    it("still flags a real standalone domain term 'hasan'", () => {
      expect(
        sourceLineViolations("// grade: hasan", file, RULES),
      ).toContain("Islamic-domain identifier in an engine package");
    });

    it("still flags 'sanad', 'isnad', 'sharh', 'matn' as whole words", () => {
      const domain = "Islamic-domain identifier in an engine package";
      expect(sourceLineViolations("const sanad = 1;", file, RULES)).toContain(domain);
      expect(sourceLineViolations("const isnad = 1;", file, RULES)).toContain(domain);
      expect(sourceLineViolations("const sharh = 1;", file, RULES)).toContain(domain);
      expect(sourceLineViolations("const matn = 1;", file, RULES)).toContain(domain);
    });

    it("still flags the longer unanchored domain terms (e.g. 'quranic')", () => {
      // 'quran' is left unanchored so suffixed forms stay caught.
      expect(
        sourceLineViolations("// a quranic reference", file, RULES),
      ).toContain("Islamic-domain identifier in an engine package");
    });

    it("flags a vendor name in engine TS source", () => {
      expect(
        sourceLineViolations("const model = 'gemini-1.5-pro';", file, RULES),
      ).toContain("vendor or model name outside config");
    });

    it("flags a direct DB-client import in engine TS source", () => {
      expect(
        sourceLineViolations("import { neon } from '@neondatabase/serverless';", file, RULES),
      ).toContain("direct database client outside the RagStore seam");
    });
  });

  describe("#42 — package.json dependency-name scanning", () => {
    it("would catch 'drizzle-orm' in a non-adapter engine package.json", () => {
      // Synthetic: rag-core is NOT the infra adapter, so a DB-client dep is a
      // violation that must fail the gate.
      const hits = dependencyViolations(
        ["@app/contracts", "drizzle-orm", "vitest"],
        RULES,
        "packages/rag-core/package.json",
      );
      expect(hits).toContainEqual({
        name: "drizzle-orm",
        rule: "direct database client outside the RagStore seam",
      });
    });

    it("would catch '@neondatabase/serverless' in a non-adapter engine package.json", () => {
      const hits = dependencyViolations(
        ["@neondatabase/serverless"],
        RULES,
        "packages/eval/package.json",
      );
      expect(hits).toContainEqual({
        name: "@neondatabase/serverless",
        rule: "direct database client outside the RagStore seam",
      });
    });

    it("does NOT flag the infra adapter manifest's sanctioned DB dep", () => {
      // packages/infra is the RagStore adapter home — its manifest legitimately
      // declares the driver and is exempt from the dependency check.
      const hits = dependencyViolations(
        ["@neondatabase/serverless", "drizzle-orm"],
        RULES,
        "packages/infra/package.json",
      );
      expect(hits).toEqual([]);
    });

    it("does NOT run the Islamic-domain rule against dependency names", () => {
      // A dep literally named with a domain word must not trip the domain rule,
      // which is source-vocabulary-scoped only.
      const hits = dependencyViolations(
        ["hasan-utils", "sanad-lib"],
        RULES,
        "packages/rag-core/package.json",
      );
      expect(hits).toEqual([]);
    });

    it("does NOT flag ordinary safe dependencies", () => {
      const hits = dependencyViolations(
        ["valibot", "vitest", "@app/contracts", "hono", "@aws-sdk/client-s3"],
        RULES,
        "packages/rag-core/package.json",
      );
      expect(hits).toEqual([]);
    });
  });

  describe("boundary gate CLI", () => {
    it("reports 0 violations on the current repo", () => {
      // Integration: the real script over the real working tree must be clean.
      const out = execFileSync("bun", [CLI], { encoding: "utf8" });
      expect(out.trim()).toBe("boundary: engine packages clean (0 violations)");
    });
  });
});