#!/usr/bin/env bun
// dsh-dispatch-prompt.mjs — assemble the standalone dispatch prompt for a
// manager role, from the role's definition file.
//
// The DSH adapter dispatches roles as generic `subagent` calls whose prompt
// must carry (a) the task, (b) the role definition from
// .zcode/agents/<role>.md — the single source of truth, and (c) the
// dispatcher's per-run authorization. Hand-assembling that prompt each time
// is where consistency dies: a body mis-copied here is a silent contract
// break. This script prints the assembled prompt to stdout, verbatim-worthy:
// the agent passes it to `subagent` unchanged.
//
// The script appends only what the role bodies do not already carry — the
// per-run authorization section. Which roles carry PR-opening authorization
// is decided by the role files themselves (a "## Dispatch authorization"
// section in the body), never by a table in this script: the role file stays
// the single source of truth and a new PR-opening role needs no script edit.
//
// Usage:
//   bun run dsh:prompt --role implementer --task "implement ticket #12"
//   bun run dsh:prompt --role reviewer --task-file pr-context.md
// The prompt goes to stdout; diagnostics go to stderr.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROLES_DIR = join(import.meta.dir, "..", ".zcode", "agents");

/** The manager's role set. The role argument is validated against this list —
 * a dispatch prompt carries commit/push/PR authority, so it is assembled only
 * from a known role file, never from an arbitrary path. */
const ROLES = new Set([
  "implementer",
  "senior-implementer",
  "reviewer",
  "assistant-manager",
  "thermo-nuclear-review-subagent",
  "thermo-nuclear-code-quality-review-subagent",
]);

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
}

const role = argOf("--role");
const task = argOf("--task");
const taskFile = argOf("--task-file");

function fail(message) {
  console.error(`✗ ${message}`);
  console.error(`  usage: bun run dsh:prompt --role <role> (--task <text> | --task-file <path>)`);
  console.error(`  roles: ${[...ROLES].join(", ")}`);
  process.exit(1);
}

if (!role) fail("--role is required");
if (!ROLES.has(role)) fail(`unknown role "${role}" — must be one of: ${[...ROLES].join(", ")}`);

let taskText = null;
if (task !== null && taskFile !== null)
  fail("--task and --task-file are mutually exclusive — pass the task exactly once");
if (task !== null) taskText = task;
if (taskFile !== null) {
  try {
    taskText = await readFile(taskFile, "utf8");
  } catch (error) {
    fail(`cannot read task file ${taskFile} (${error.code ?? error.message})`);
  }
}
if (taskText === null) fail("one of --task or --task-file is required");
if (!taskText.trim())
  fail(`task text is empty — the task is the one per-run manager-authored input and cannot be blank (source: ${taskFile ?? "--task"})`);

let roleBody;
try {
  const text = await readFile(join(ROLES_DIR, `${role}.md`), "utf8");
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  roleBody = fm ? text.slice(fm[0].length) : text;
} catch (error) {
  fail(`cannot read the role file ${join(ROLES_DIR, `${role}.md`)} (${error.code ?? error.message})`);
}
if (!roleBody.trim()) fail(`${role}.md carries no body`);

const sections = [`## Task\n\n${taskText.trim()}`, `## Role definition\n\n${roleBody.trim()}`];
process.stdout.write(sections.join("\n\n") + "\n");
console.error(`ℹ dispatch prompt assembled for "${role}" (${sections.join("\n\n").length} chars) — pass stdout verbatim to \`subagent\``);
