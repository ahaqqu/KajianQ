import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The generated-section contract of `bun run dsh:prompt` (issue #224).
 *
 * The script's header comment is the canonical statement of what it emits, and
 * it claims exactly two sections: `## Task` then `## Role definition` (the role
 * file's body verbatim, frontmatter stripped), with nothing appended. That
 * claim has drifted before — the header comment once said the script appended a
 * per-run authorization section that never existed, and the DSH adapter copied
 * the false claim — so it is pinned here for every role. A third appended
 * section fails this test, and so does a rewritten or truncated role body.
 */

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/dsh-dispatch-prompt.mjs");
const ROLES_DIR = join(ROOT, ".zcode", "agents");

// The section list documented in the script's header comment, in order.
const GENERATED_SECTIONS = ["## Task", "## Role definition"];
const ROLES = ["implementer", "senior-implementer", "fixer", "reviewer"];

function stripFrontmatter(text) {
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (fm ? text.slice(fm[0].length) : text).trim();
}

describe("dsh:prompt — documented section list", () => {
  for (const role of ROLES) {
    it(`emits exactly ${GENERATED_SECTIONS.join(" + ")} for "${role}"`, () => {
      const task = `task text for ${role}`;
      const res = spawnSync("bun", [SCRIPT, "--role", role, "--task", task], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);

      const body = stripFrontmatter(readFileSync(join(ROLES_DIR, `${role}.md`), "utf8"));
      // Exact equality is the check: any generated section beyond the
      // documented two — an authorization section included — breaks it.
      expect(res.stdout).toBe(
        `${GENERATED_SECTIONS[0]}\n\n${task}\n\n${GENERATED_SECTIONS[1]}\n\n${body}\n`,
      );

      // The generated headings precede the role body, in the documented order;
      // headings after that point belong to the body, not to the script.
      const generatedHeader = res.stdout.slice(0, res.stdout.indexOf(body));
      expect(generatedHeader.match(/^## .+$/gm)).toEqual(GENERATED_SECTIONS);
    });
  }
});
