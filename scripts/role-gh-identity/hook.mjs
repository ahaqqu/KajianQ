#!/usr/bin/env bun
// ZCode workspace hook: role-separated GitHub identity enforcement.
//
// Wiring (.zcode/config.json, PreToolUse on `Bash`):
//   deny a bare `gh` call from a role subagent that has a configured
//   identity, redirecting to the `gh-as <role>` wrapper.
//
// Guarantees (the invariant, see lib.mjs's header comment):
// - Deny ONLY when: enforcement enabled (config.json `enabled: true`) AND
//   the session resolves to a role with a configured identity AND the
//   command invokes bare `gh`. Everything else allows.
// - Fail OPEN: unreadable config, absent session identity, metadata scan
//   errors — all exit 0 with no deny. A broken hook must never trap an
//   agent (same doctrine as the iteration-guardrail).
// - The deny reason names the compliant wrapper command; the token file
//   contents never enter the agent's context (only the hook's config knows
//   paths, and the deny message does not even carry those — just the role).
//
// Environment overrides (used by tests): ZCODE_ROLE_IDENTITY_CONFIG
// (config path), ZCODE_AGENTS_DIR (agents metadata dir), ZCODE_PROJECT_DIR.
//
// Role resolution order (probed; see tests/scripts/role-gh-identity.test.mjs):
// 1. payload `agent_type` — present on ZCode subagent dispatches per the
//    committed runtime-envelope fixture.
// 2. agents-dir metadata scan: `~/.zcode/cli/agents/<parent>/agent_*/metadata.json`
//    matched by `childSessionId` (convention `sess_subagent_agent_<id>`), whose
//    `profileSnapshot.name` carries the role — the same lookup pattern as
//    scripts/agent-usage-metadata.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseZcodeHookPayload } from "../../packages/contracts/src/zcode-hook";
import { parseRoleIdentityConfig } from "../../packages/contracts/src/role-identity";
import { evaluateIdentityCall, resolveRole } from "./lib.mjs";

const DEFAULT_AGENTS_DIR = join(homedir(), ".zcode", "cli", "agents");

function emit(event, fields) {
  // Structured JSON on stderr only. Never exit non-zero for logging problems.
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), script: "role-gh-identity", event, ...fields })}\n`,
  );
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function commandFrom(payload) {
  const input = payload.tool_input;
  if (input && typeof input === "object" && typeof input.command === "string") {
    return input.command;
  }
  return null;
}

// Agents-dir fallback for envelopes without `agent_type`: scan one level of
// parent-session dirs, match the metadata record by childSessionId or
// agentId (extracted from the `sess_subagent_agent_<id>` convention), and
// return the role from the profile snapshot name.
function makeMetadataLookup(agentsDir) {
  return (sessionKey) => {
    let parents;
    try {
      parents = readdirSync(agentsDir);
    } catch {
      return null;
    }
    const agentId = sessionKey.startsWith("sess_subagent_agent_")
      ? `agent_${sessionKey.slice("sess_subagent_agent_".length)}`
      : null;
    for (const parent of parents) {
      let agents;
      try {
        agents = readdirSync(join(agentsDir, parent));
      } catch {
        continue;
      }
      for (const agent of agents.filter((a) => a.startsWith("agent_"))) {
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(join(agentsDir, parent, agent, "metadata.json"), "utf8"));
        } catch {
          continue;
        }
        if (parsed.childSessionId === sessionKey || (agentId && parsed.agentId === agentId)) {
          return { role: parsed.profileSnapshot?.name };
        }
      }
    }
    return null;
  };
}

function buildDenyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function main() {
  let payload;
  try {
    const parsed = parseZcodeHookPayload(JSON.parse(readStdin()));
    if (!parsed.ok) return 0; // not our envelope — fail-open
    payload = parsed.payload;
  } catch {
    return 0; // unreadable stdin — fail-open
  }
  if (payload.hook_event_name !== "PreToolUse" || payload.tool_name !== "Bash") return 0;

  const command = commandFrom(payload);
  if (command === null) return 0;

  let config;
  try {
    const configPath =
      process.env.ZCODE_ROLE_IDENTITY_CONFIG ||
      join(process.env.ZCODE_PROJECT_DIR || process.cwd(), "scripts", "role-gh-identity", "config.json");
    const parsed = parseRoleIdentityConfig(JSON.parse(readFileSync(configPath, "utf8")));
    if (!parsed.ok) {
      emit("skip_invalid_config", { reason: parsed.reason });
      return 0;
    }
    config = parsed.config;
  } catch (e) {
    emit("skip_no_config", { reason: e.message });
    return 0;
  }
  if (!config.enabled) return 0;

  const agentsDir = process.env.ZCODE_AGENTS_DIR || DEFAULT_AGENTS_DIR;
  const role = resolveRole(payload, makeMetadataLookup(agentsDir), payload.session_id ?? "");
  const verdict = evaluateIdentityCall({ command, role, config });
  if (verdict.deny) {
    emit("deny_bare_gh", { role, commandPreview: command.slice(0, 200) });
    process.stdout.write(buildDenyOutput(verdict.reason));
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  emit("error_hook", { reason: e?.message });
  process.exitCode = 0; // fail-open
}