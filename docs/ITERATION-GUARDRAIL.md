# Iteration guardrail (issue #98)

A mechanical, progress-based cap on failed verification cycles, enforced by a
workspace `PreToolUse` hook instead of policy prose. It is the enforcement arm
of the escalation guardrail designed in issue #94: the escalation ladder is
**implementer → manager → owner**, and the mechanical cap guarantees the first
hop actually happens.

## Invariant

A deny fires **only** on confident evidence of repeated failed verification
cycles for the same problem in the current session. The guardrail must never
fire on distinct-progress work, must fail **open** on its own internal errors
(a broken guardrail must never trap an agent), and every deny must carry the
full stuck-report escalation instruction.

## What counts as a cycle

- One cycle = a fix attempt (an `Edit`/`Write`) + a verification rerun.
- The stuck signal is the **same failure recurring after a fix attempt**
  (identical failure signature: normalized command + normalized output), or a
  **rerun with no state change between cycles** — any output difference then
  is flake, not progress.
- Both counters **reset on a successful verification**: a success is evidence
  the loop converges, so the budget restarts. This is what makes the caps
  progress-based rather than a raw session count that would brick long
  legitimate sessions.

## Caps (configurable)

`scripts/iteration-guardrail/config.json`:

| Cap | Default | Meaning |
| --- | --- | --- |
| `sameFailureCap` | 3 | Failed cycles on the same failure signature before reruns are denied. |
| `distinctFailureCap` | 8 | Failed cycles since the last successful verification before reruns are denied. |
| `verificationPatterns` | (see file) | Substring regexes classifying a `Bash` command as a verification command. |

The hook loads the config on every event, so edits take effect immediately;
invalid fields fall back to defaults (fail-open) with a structured warning on
stderr.

## Wiring (`.zcode/config.json`)

| Event | Matcher | Role |
| --- | --- | --- |
| `PreToolUse` | `Bash` | Evaluate the caps; deny a verification rerun past them. |
| `PostToolUse` | `Bash` | Record the verification outcome (`status`/`exitCode` from the tool response). |
| `PostToolUse` | `Edit\|Write` | Record a fix attempt (state change). |
| `PostToolUseFailure` | `Bash` | Harness-level tool failure counts as a failed cycle (cancelled calls never count). |

First enablement requires hook trust (`zcode hooks trust grant` or the desktop
review flow), same as any workspace hook.

## Fail-open guarantees

- Any internal error — unreadable config, corrupted state file, unexpected
  exception, missing session identity — exits 0 with **no deny**; the reason is
  emitted as a structured JSON line on stderr.
- State writes are atomic (tmp file + fsync + rename); unreadable state is
  discarded, never interpreted as evidence.
- Non-verification commands (including `git commit` — the checkpoint duty) are
  never blocked.
- The ZCode runtime itself treats a crashed hook as a no-op, so a deny is only
  ever produced by the explicit decision path in the hook.

## The deny message

A deny is the runtime-documented `PreToolUse` decision
(`hookSpecificOutput.permissionDecision: "deny"`); its reason is the tool error
the agent sees and carries the stuck-report instruction: invariant under test,
exact current failure, attempted fixes with outcomes, ruled-out hypotheses,
checkpoint commit ref (commit first — escalation must never lose work).

**Never fake done:** the cap exists to prevent unbounded spend and silent
wear-down success claims; it changes nothing about the completion criterion —
a PR must exist and `gh pr checks` must be green. Escalation is the response
to a deny, never a success claim without evidence.

## State

Per-session JSON under `$TMPDIR/zcode-iteration-guardrail/<project-hash>/`
(override with `ZCODE_GUARDRAIL_STATE_DIR`; config path override:
`ZCODE_GUARDRAIL_CONFIG`). A new session starts with clean counters, which is
what makes the manager ladder coherent: a re-dispatch with a different approach
restarts the budget.

**Threat model (review A4).** The state lives in the shared `$TMPDIR`, on disk
under the same user account as the guarded agent, and that agent can run
arbitrary shell — so the guardrail is an advisory safety belt against
stuck-but-cooperative loops, not a tamper-proof boundary: a determined process
could delete or edit its own state file. Permissions are tightened regardless
(state dir `0700`, state files `0600`) so the stored command lines and failure
previews are never world-readable. The previews are kept deliberately (rather
than hash-only): the deny message's "exact current failure" evidence is
load-bearing for the stuck-report the receiver must be able to act on.

**Compound commands (review A6).** A compound command containing a
verification step (`bun run test && git commit -m ...`) is classified as a
verification command and can be denied at a breached cap — run the checkpoint
commit as its own command. The deny message says so. Exempting git-write
compound commands from classification was rejected: `bun run test && git
commit` would become a trivial cap-evasion channel.

**Envelope fixtures (review A5).** `scripts/iteration-guardrail/fixtures/`
holds runtime-derived hook payloads (full envelope, including fields the
guardrail ignores) parsed by the CI suite, so a contract drift from the live
envelope fails CI instead of silently disabling the hook. They are derived
from the runtime's hook-input serialization, not yet replaced by a redacted
live capture.
