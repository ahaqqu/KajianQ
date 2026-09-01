# ADR-0025: Role-separated GitHub identities enforced by a PreToolUse deny hook

## Status

Accepted (2026-09-01). Records the identity-attribution decision for the manager-orchestrated agentic workflow. Builds on ADR-0009 (no secrets committed; price/config discipline), the iteration-guardrail doctrine (mechanical enforcement over prose, fail-open hooks), and ADR-0023 (per-role machinery in fork-owned files).

## Context

The manager workflow's role subagents (`implementer`, `senior-implementer`, `reviewer`, `assistant-manager`, `test-implementer`) all interact with GitHub through `gh`, which authenticates through one global credential (`~/.config/gh/hosts.yml` or the ambient `GH_TOKEN`). Every PR, review comment, and disposition reply therefore posts as the owner's personal account, `ahaqqu`. The owner wants role-separated GitHub identities (e.g. `ahaqqu-implementer`, `ahaqqu-reviewer`) so the PR timeline self-documents which role did what.

GitHub's TOS permits one human operating multiple accounts; the constraint is mechanical, not legal. Two candidate mechanisms were considered:

1. **`gh auth switch` per dispatch** — rejected: the auth state is process-global, and the manager runs implementer and reviewer subagents in parallel background dispatches. Parallel roles would race each other's account switches.
2. **Per-invocation `GH_TOKEN` through a wrapper (`gh-as <role> <gh args…>`)** — chosen: each `gh` invocation carries its own identity, parallel roles never interfere, and the manager session (no role) keeps the owner's default identity.

A wrapper alone is an *instruction* — an agent that misses it silently posts under the wrong identity, which is exactly the failure class the owner asked to avoid (same reasoning as issue #98: mechanical guardrails over prose). The owner explicitly rejected instruction-only enforcement.

## Verified runtime facts (probed 2026-09-01)

- The Claude-compatible hook envelope carries `agent_type` on subagent dispatches (committed runtime fixture `scripts/iteration-guardrail/fixtures/pre-tool-use-bash.json`, serialized by the runtime's `createClaudeCompatibleHookStdin`).
- `metadata.json` agent records exist while the agent runs (probed: records with `status: "running"`) and carry `childSessionId` (convention `sess_subagent_agent_<id>`) plus `profileSnapshot.name` — the session→role fallback channel, same lookup pattern as `scripts/agent-usage-metadata`.
- PreToolUse `permissionDecision: "deny"` with a `permissionDecisionReason` is enforcement-proven: the iteration-guardrail already denies subagent Bash calls live (issue #98).
- `updatedInput` command rewriting exists in the Claude-compatible envelope but is **unverified on ZCode**, and a rewrite would surface the modified command (including any identity context) in the transcript. The deny-redirect design keeps token paths out of the agent's context entirely — chosen for both verified-ness and secrecy.

## Decision

1. **Deny-redirect, not instruction and not rewrite.** A PreToolUse Bash hook (`scripts/role-gh-identity/hook.mjs`, wired in `.zcode/config.json` beside the iteration-guardrail) denies a bare `gh` invocation from a role subagent that has a configured identity. The deny reason names the exact compliant form (`gh-as <role> <original args>`); the agent cannot miss the mechanism — a missed instruction becomes a failed command with the correction, not a silent post under the owner's account.
2. **`gh-as <role>` wrapper (`scripts/role-gh-identity/gh-as.mjs`).** Reads the role's token file (outside the repo, `~`-expanded at call time), exports it as `GH_TOKEN` for exactly that invocation, and execs `gh` as a pass-through for every subcommand. No ambient-credential fallback: a missing/unreadable token fails loudly rather than silently posting as the owner. `gh-as <role> auth status` prints the role→account mapping from an identities file without ever printing a token.
3. **Opt-in enforcement.** The shipped config (`scripts/role-gh-identity/config.json`) has `enabled: false`; the hook is a complete no-op until the owner mints per-role tokens (fine-grained PATs) and flips the flag. The deny must never fire while identities are unconfigured. Config schema is a contract (`RoleIdentityConfigSchema` in `packages/contracts/src/role-identity.ts`) — contracts before implementation (§10).
4. **Fail-open everywhere.** Unreadable config, absent session identity, metadata-scan errors, unknown envelope shapes, unresolvable role, unconfigured role — all allow. A broken identity hook must never trap an agent (same doctrine as the iteration-guardrail). The only deny condition is: enforcement enabled AND session resolves to a role with a configured identity AND the command invokes bare `gh`. Missed evasion shapes also fail in the safe direction: the call runs under the default identity, exactly the enforcement-off behavior.
5. **Token discipline (ADR-0009).** Token files live outside the repo under a per-role path (`~/.config/kajianq/gh-identities/`); paths are config, contents are never read by the hook (only by the wrapper), and neither the deny message nor any skill/prompt text carries a token path or token. Rotation is a file swap; per-role auth failures surface to the manager as ordinary command failures and escalate per its protocol.
6. **`agent_type` joins the hook-envelope contract.** The zcode-hook payload schema (`packages/contracts/src/zcode-hook.ts`) now models `agent_type` as optional on all three events — it is observed runtime behavior carried by the committed fixtures, and the identity hook's primary role-resolution channel; the metadata-scan is the fallback.
7. **Fork-owned paths only.** `scripts/role-gh-identity/` is deliberately outside the template-sync overwrite set (`template-sync.json`); no template-owned file was touched. The manager-skill prose (a "merge-decision concerns" bullet in step 6, and role-identity wording) is a template upstream change, not a fork edit (ADR-0024 ownership discipline).

## Consequences

- Role subagents with configured identities mechanically cannot post `gh` calls as the owner's account; the PR timeline attributes each comment/PR to the acting role account.
- The owner mints the per-role accounts/PATs (GitHub side) and flips `enabled: true` — until then the machinery ships inert (shipped default verified by test: the committed fixture with a bare-`gh` command must allow).
- The detection is segment-based (split on shell operators, strip keywords/assignments, check for a `gh` invocation) — it catches `&&`-chained, `bash -c`, `if`, `exec`/`env`/`xargs`, and `VAR=… gh` shapes, and is tested against prose false-positive traps (`git commit -m 'gh …'`, `cat ~/.config/gh/…`) and wrapper false-negative traps (`gh-as reviewer pr view && gh api …` must still deny). It is a hardened guardrail against honest misses, not a sandbox against adversarial evasion.
- The manager session itself (no `agent_type`, no subagent session) is never denied — it keeps the owner's identity, and merging stays the owner's manual decision (AGENTS.md working agreement).
- Role accounts need write access to the repo (or the reviewer works from a fork, complicating review-comment posting — noted as an open operational choice for the owner at enablement time).
- One more secret per role to rotate and one more auth-failure mode for the manager to escalate — the operational costs of auditability, accepted.