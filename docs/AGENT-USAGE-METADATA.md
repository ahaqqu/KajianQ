# Agent usage metadata hook

Every dispatched role subagent gets its real token usage (input, output,
request count, cache reads, wall time) appended to its agent `metadata.json`
automatically, so per-run cost is visible to the manager and the owner without
hand-querying the local telemetry DB. Implements
[issue #95](https://github.com/ahaqqu/agentic-project-template/issues/95)
(parent hardening issue #94: a 36.3M-input-token run billed over 280 requests
with nothing surfacing it).

## Pieces

| Path | Role | template-sync ownership |
| --- | --- | --- |
| `scripts/agent-usage-metadata/hook.mjs` | Hook entrypoint the runtime spawns with the payload JSON on stdin. | `overwrite` — forks inherit updates |
| `scripts/agent-usage-metadata/lib.mjs` | Pure logic: payload contract, `model_usage` row summation, guarded metadata merge. | `overwrite` — forks inherit updates |
| `.zcode/config.json` | Workspace hook config: enables configuration-file hooks and wires the capture points (see below). | `overwrite` since issue #125 — forks inherit the wiring via sync; `bun run template-gate` fails when it is missing or altered |
| `tests/scripts/agent-usage-metadata.test.mjs` | Unit + subprocess tests for every acceptance criterion. | unlisted — project-owned, replicate (below) |
| `docs/AGENT-USAGE-METADATA.md` | This document. | unlisted — project-owned, replicate (below) |

## Capture points

The runtime fires workspace hooks per session; a subagent's usage rows in the
telemetry DB are final at different moments depending on how it ran, so the
hook recognizes two events (all no-ops for unrelated tools/sessions):

1. **PostToolUse on `Agent`** — a foreground dispatch completed.
   `tool_use_id` maps to the agent record's `parentToolUseId`.
2. **PostToolUse on `TaskOutput`** — the manager collected a background
   subagent's result; `tool_input.task_id` maps to the agent record's
   `agentId`. This is the reliable capture point for background dispatches.

There is deliberately **no `Stop` capture point**: the ZCode runtime fires
`Stop` only for interactive/parent sessions, never for subagent child
sessions (verified live — a Stop-capture prototype recorded nothing). Keeping
it would only add a full agents-dir scan on every session stop. Any
`Stop`/other payload is rejected by the payload contract as an observable
no-op (`skip_payload`), so future harnesses that do fire useful `Stop` events
surface immediately in the log instead of silently doing nothing.

For each capture the hook sums the child session's `model_usage` rows from
`~/.zcode/cli/db/db.sqlite` (read-only) and merges totals into
`~/.zcode/cli/agents/<parentSessionId>/agent_<agentId>/metadata.json` under
the hook-owned keys `usage` and `usageCaptures`. All pre-existing keys are
preserved verbatim.

## Guarantees

- **Accumulation across resumes.** Totals are recomputed from the FULL
  `model_usage` row set of the child session on every capture. A continued
  (resumed) subagent appends rows to the same session id, so the next capture
  reflects the grown totals — verified live (capture 1: 1 request / 10,691
  input tokens; capture 2 after continuation: 2 requests / 21,395 input
  tokens, matching the DB exactly).
- **Idempotency.** Each capture carries a stable fingerprint (request counts
  + token sums); re-capturing the same DB state does not duplicate history.
- **Never corrupts.** `metadata.json` is parsed and validated before any
  write and writes are atomic (temp file + rename in the target directory).
  An unparseable record is never written into — the capture is skipped with
  an observable log line. Any guard failure means "do not write".
- **Observable.** Every skip/failure emits a structured JSON line to stderr
  and to a JSONL sidecar (`~/.zcode/cli/agent-usage-metadata.log`, override
  with `ZCODE_AGENT_USAGE_LOG`) and exits non-zero on failure. The hook never
  exits 2, so it can never block a tool or a session stop.

## Enabling the hooks in a fork

Workspace hooks are per-workspace and trust-gated by the harness (project
hook files execute code). After syncing this template:

1. Ensure `.zcode/config.json` (committed) is present in the workspace root.
2. Copy the unlisted paths the fork's sync does not carry (see the ownership
   column above): `.zcode/config.json` (minus any fork-local additions),
   `tests/scripts/agent-usage-metadata.test.mjs`, and this document —
   `scripts/agent-usage-metadata/` arrives via `scripts/` sync.
3. Grant trust once per workspace — either approve the harness's trust review
   in the desktop app, or pretrust the declarations from the CLI:

   ```
   zcode hooks trust status --workspace <workspace-path> --json   # read digests
   zcode hooks trust grant --workspace <workspace-path> --hook-digest <sha256> [...]
   ```

4. Dispatch a subagent as usual; the agent record's `metadata.json` gains a
   `usage` block on collection. Check `hooks trust status` shows
   `workspace_hooks_trusted_persistent` if captures do not appear, and the
   sidecar log for the reason of any skip.

## Environment overrides (tests)

`ZCODE_DB_PATH`, `ZCODE_AGENTS_DIR`, `ZCODE_AGENT_USAGE_LOG` redirect the
telemetry DB, the agents directory, and the sidecar log respectively.
