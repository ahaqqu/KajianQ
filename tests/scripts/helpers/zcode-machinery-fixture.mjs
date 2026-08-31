// Single test-side source of truth for the .zcode/ machinery shape the gate
// enforces (review B3 on PR #127). Both suites — zcode-machinery-check.test.mjs
// and template-sync.test.mjs — build fixtures through this module, so a
// template rewiring (event added, hook script renamed) has ONE fixture to
// update instead of three hand-copied JSON literals. Each suite asserts the
// builder's output through the gate itself (checkHookWiring /
// checkZcodeMachinery), so a gate/fixture divergence fails loudly instead of
// silently passing a shape the gate rejects.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The concrete caching-channel pin the template ships on every role. */
export const MODEL_PIN = "builtin:zai-start-plan/GLM-5.3-Flash";

/** Fresh deep copy of the template-shaped hook wiring: the exact shape
 * checkHookWiring expects — six event/matcher/script tuples, all enabled. */
export function machineryConfig() {
  return {
    hooks: {
      enabled: true,
      events: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/iteration-guardrail/hook.mjs"], enabled: true },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/iteration-guardrail/hook.mjs"], enabled: true },
            ],
          },
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/iteration-guardrail/hook.mjs"], enabled: true },
            ],
          },
          {
            matcher: "Agent",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/agent-usage-metadata/hook.mjs"], enabled: true },
            ],
          },
          {
            matcher: "TaskOutput",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/agent-usage-metadata/hook.mjs"], enabled: true },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: "Bash",
            hooks: [
              { type: "process", command: "bun", args: ["scripts/iteration-guardrail/hook.mjs"], enabled: true },
            ],
          },
        ],
      },
    },
  };
}

/** Role-file body with frontmatter. `model === undefined` omits the field
 * entirely (distinct from `inherit`/`lite`); `thoughtLevel === null` omits
 * that field (distinct from a value). */
export function roleBody(model, thoughtLevel = "high") {
  const lines = ["---", "name: implementer", "background: true", "tools: ['*']"];
  if (model !== undefined) lines.push(`model: ${model}`);
  if (thoughtLevel !== null) lines.push(`thoughtLevel: ${thoughtLevel}`);
  lines.push("---", "", "Body.", "");
  return lines.join("\n");
}

/** Write the full machinery shape into `dir` (creates .zcode/agents/):
 * config.json (unless `over.config`), implementer.md (unless
 * `over.implementer`), and the registry README (excluded from role checks).
 * Returns the dir for chaining. */
export function writeMachineryFixture(dir, over = {}) {
  mkdirSync(join(dir, ".zcode", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".zcode", "config.json"),
    JSON.stringify(over.config ?? machineryConfig()),
  );
  writeFileSync(
    join(dir, ".zcode", "agents", "implementer.md"),
    over.implementer ?? roleBody(MODEL_PIN),
  );
  writeFileSync(join(dir, ".zcode", "agents", "README.md"), "# registry\n");
  return dir;
}

/** Fresh temp dir with the complete, gate-green machinery shape. */
export function machineryTmpFixture(over = {}) {
  return writeMachineryFixture(mkdtempSync(join(tmpdir(), "zcode-machinery-")), over);
}
