import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The generated-section contract of `bun run dsh:prompt` (issue #224).
 *
 * The script's header comment is the canonical statement of what it emits, and
 * it claims exactly two sections: `## Task` (the manager-authored task text,
 * trimmed) then `## Role definition` (the role file's body, frontmatter
 * stripped and trimmed), with nothing appended. That claim has drifted before —
 * the header comment once said the script appended a per-run authorization
 * section that never existed, and the DSH adapter copied the false claim — so
 * it is pinned here for every role. A third appended section fails this test,
 * and so does a rewritten or truncated role body.
 *
 * Neither list is left hand-synced without a check: the roles come from the
 * script's own allowlist, so a future fifth role is pinned automatically, and
 * the section constant below is asserted equal to the table in the header
 * comment, so the comment the DSH adapter calls canonical cannot drift away
 * from what the emission is checked against.
 */

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/dsh-dispatch-prompt.mjs");
const ROLES_DIR = join(ROOT, ".zcode", "agents");
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

// The section list documented in the script's header comment, in order. Kept as
// a literal so the "matches the section table" test below can catch the comment
// and this constant diverging; a hand-copied second copy with no coupling is
// exactly the drift this suite exists to catch. Trade-off, accepted knowingly:
// reformatting the documented table trips that test — loudly, and only when
// someone is editing the documented contract, which is exactly when the copies
// must be re-synced.
const GENERATED_SECTIONS = ["## Task", "## Role definition"];

/** The section table in the script's header comment: the `//   ## X   <desc>`
 * rows that follow the list's opening phrase, up to the first non-row comment
 * line (the prose paragraph that closes the list). */
function documentedSections() {
  const anchor = SCRIPT_SOURCE.indexOf("It emits exactly");
  if (anchor === -1) {
    throw new Error(
      "cannot read the documented section list from the header comment of " +
        'scripts/dsh-dispatch-prompt.mjs: expected it to open with "It emits exactly"',
    );
  }
  const sections = [];
  for (const line of SCRIPT_SOURCE.slice(anchor).split("\n").slice(1)) {
    if (!line.startsWith("//")) break; // the table lives inside the header comment
    const text = line.replace(/^\/\/\s*/, "").trimEnd();
    if (!text) continue; // blank comment line between rows
    if (!text.startsWith("## ")) break; // the paragraph following the table
    sections.push(text.split(/\s{2,}/)[0]);
  }
  if (sections.length === 0) {
    throw new Error(
      "cannot read the documented section list from the header comment of " +
        "scripts/dsh-dispatch-prompt.mjs: found no `//   ## X` table rows after " +
        '"It emits exactly"',
    );
  }
  return sections;
}

/** The role allowlist from the script source, so this suite follows the
 * script's own authority instead of duplicating it. */
function rolesFromScriptSource() {
  const match = SCRIPT_SOURCE.match(/const ROLES = new Set\(\[([^\]]*)\]\)/);
  if (!match) {
    throw new Error(
      "cannot read the role allowlist from scripts/dsh-dispatch-prompt.mjs: " +
        "expected a `const ROLES = new Set([...])` declaration",
    );
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const ROLES = rolesFromScriptSource();

function stripFrontmatter(text) {
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (fm ? text.slice(fm[0].length) : text).trim();
}

describe("dsh:prompt — documented section list", () => {
  it("matches the section table in the script's header comment", () => {
    expect(documentedSections()).toEqual(GENERATED_SECTIONS);
  });

  for (const role of ROLES) {
    it(`emits exactly ${GENERATED_SECTIONS.join(" + ")} for "${role}"`, () => {
      // Surrounding whitespace pins the documented trim: an implementation
      // that stopped trimming would emit these spaces verbatim.
      const task = `  task text for ${role}  `;
      const res = spawnSync("bun", [SCRIPT, "--role", role, "--task", task], {
        encoding: "utf8",
      });
      expect(res.status, `dsh:prompt failed for "${role}":\n${res.error ?? ""}${res.stderr}`).toBe(
        0,
      );

      const body = stripFrontmatter(readFileSync(join(ROLES_DIR, `${role}.md`), "utf8"));
      // Exact equality is the check: any generated section beyond the
      // documented two — an authorization section included — breaks it.
      expect(res.stdout).toBe(
        `${GENERATED_SECTIONS[0]}\n\n${task.trim()}\n\n${GENERATED_SECTIONS[1]}\n\n${body}\n`,
      );

      // The generated headings precede the role body, in the documented order;
      // headings after that point belong to the body, not to the script.
      const generatedHeader = res.stdout.slice(0, res.stdout.indexOf(body));
      expect(generatedHeader.match(/^## .+$/gm)).toEqual(GENERATED_SECTIONS);
    });
  }
});
