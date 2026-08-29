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
// PR-permission grant (the one per-run, manager-authored input). Role bodies
// already carry their completion criteria, skills, and reporting contract.
//
// Usage:
//   bun run dsh:prompt --role implementer --task "implement ticket #12"
//   bun run dsh:prompt --role reviewer --task-file pr-context.md
// The prompt goes to stdout; diagnostics go to stderr.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROLES_DIR = join(process.cwd(), ".zcode", "agents");

/** Per-run authorization the dispatcher adds on top of the role body. Only
 * roles that open PRs get the grant; reviewers, fact-finders, and the thermo
 * sub-reviewers get nothing extra (their bodies carry their contracts). */
const EPILOGUE = new Map([
  [
    "implementer",
    "## Dispatch authorization\n\nYou are explicitly authorized to commit, push, and open a pull request for this task. Never merge it — the manager verifies CI and takes it from there.",
  ],
  [
    "senior-implementer",
    "## Dispatch authorization\n\nYou are explicitly authorized to commit, push, and open a pull request for this task. Never merge it — the manager verifies CI and takes it from there.",
  ],
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
  console.error(`  roles: implementer, senior-implementer, reviewer, assistant-manager,`);
  console.error(`         thermo-nuclear-review-subagent, thermo-nuclear-code-quality-review-subagent`);
  process.exit(1);
}

if (!role) fail("--role is required");
const roleFile = join(ROLES_DIR, `${role}.md`);
let roleBody;
try {
  const text = await readFile(roleFile, "utf8");
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  roleBody = fm ? text.slice(fm[0].length) : text;
  if (!roleBody.trim()) fail(`${role}.md carries no body`);
} catch {
  fail(`unknown role: no ${join(".zcode", "agents", `${role}.md`)}`);
}

let taskText = task ?? "";
if (taskFile) taskText = (await readFile(taskFile, "utf8")).trim();
if (!taskText && !taskFile) fail("one of --task or --task-file is required");

const sections = [`## Task\n\n${taskText.trim()}`, `## Role definition\n\n${roleBody.trim()}`];
const epilogue = EPILOGUE.get(role);
if (epilogue) sections.push(epilogue);
process.stdout.write(sections.join("\n\n") + "\n");
console.error(`ℹ dispatch prompt assembled for "${role}" (${sections.join("\n\n").length} chars) — pass stdout verbatim to \`subagent\``);