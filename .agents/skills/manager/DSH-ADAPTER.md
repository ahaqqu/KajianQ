# DSH adapter — dispatching the manager's roles on DeepSeek Harness

The manager skill (`SKILL.md`) is harness-neutral; this file is its **DSH (DeepSeek Harness) adapter** and the single home for DSH dispatch mechanics, model routing, and their verification. Load it only when running the manager loop on DSH. The role pins live in `.zcode/agents/<role>.md` — the single source of truth for role models on every harness; this file defines how DSH honors them.

Verified against the installed DSH by live probes (2026-08-29): foreground and background (continuable) spawn, `send_message` continuation, nested spawns **including from workflow children** (the reviewer pattern), and per-agent model overrides via `workflow`.

## Dispatch recipe — all six roles

DSH has no named agent types and no agent-definition files, so the role definition travels in the prompt — assembled by script, never by hand. `bun run dsh:prompt --role <role> (--task <text> | --task-file <path>)` prints the complete standalone prompt: the role body from `.zcode/agents/<role>.md` (the single source of truth) — including, where the role opens PRs, the "Dispatch authorization" section carried in the role file itself. Pass stdout verbatim to `subagent` — the agent opens no role files.

| Role | DSH dispatch |
| --- | --- |
| A — implementer | generic `subagent`, background (durable id); prompt assembled by `bun run dsh:prompt --role implementer --task <task>`. Continue with `send_message` for the CI-fix relay (a workflow-pinned dispatch respawns fresh instead — see Model routing). |
| A — senior-implementer | same; prompt assembled by `bun run dsh:prompt --role senior-implementer` — the invariant-first lead is in the role body. |
| B — reviewer | generic `subagent`, background; prompt assembled by `bun run dsh:prompt --role reviewer --task <pr-context>`. It spawns its two sub-reviewers itself (nested spawn verified). |
| sub-reviewer (security) | child generic `subagent` with the baseline prompt from `thermo-nuclear-review/SKILL.md` inlined (or `bun run dsh:prompt --role thermo-nuclear-review-subagent`) — DSH has no subagent types for them; this is the fallback `thermos-with-comments` already allows. |
| sub-reviewer (quality) | child generic `subagent` with the baseline prompt from `thermo-nuclear-code-quality-review/SKILL.md` inlined (or the matching `--role`). |
| C — assistant-manager | generic `subagent`, background; prompt assembled by `bun run dsh:prompt --role assistant-manager --task <question>`. Read-only is enforced by the role body's constraints — DSH exposes no per-call tool filter. |

## Mechanics

- **Spawn:** assemble by script (`bun run dsh:prompt --role <role>`), pass stdout verbatim to `subagent`. Task, role body, completion criterion, and (where the role opens PRs) the dispatch authorization are baked in — no dispatch prompt is hand-worded. Result arrives as a settle notice; the id stays continuable.
- **Resume:** `send_message` to the subagent id (manager steps 2 and 5); list with `list_agents`; cancel a stalled turn with `interrupt_agent`. These are session tools the manager calls in-conversation — the scriptable surface around them is `dsh:prompt` (prompt assembly) and `dsh:preflight` (pin resolution).
- **Approvals:** DSH subagents run with their approval policy pinned to `never` — a rejected operation is a blocker to report, never a retry.

## Model routing

The pin in each role file's frontmatter is the single source of truth, and the DSH adapter honors it for **every** dispatch. Before model-pinned dispatch, run the preflight gate — `bun run dsh:preflight` — which reads every role pin from `.zcode/agents/` and checks each model id against the DSH provider's declared models (`~/.dsh/settings.yaml`) and the ollama.com catalog, exiting non-zero with the exact fix when one cannot resolve. `bun run dsh:preflight --fix` auto-appends missing declarations for ids the catalog serves — atomically, with a timestamped backup beside the original; an id the catalog does not serve is a pin or provider change, which `--fix` never writes: fix the pin or the provider, never reroute. Green gate, then dispatch — plain `subagent` (continuable) when the pinned model equals the session model, otherwise a `workflow` `agent()` call. The `subagent` tool itself has no per-call model override — children inherit the session model. Pins are never rerouted to a different model: the exit code, not a routing table, is what the routing claim rests on.

Verified on this install (2026-08-29): `bun run dsh:preflight` resolves all six role pins, including after simulating a removed declaration (`--fix` re-declared the id and preflight went green again). Workflow children are one-shot — a model-pinned implementer cannot be resumed with `send_message`; when its CI goes red, spawn a fresh workflow agent carrying the failing logs. Nested spawn works from `workflow` children too (probe-verified), so the reviewer keeps dispatching its two sub-reviewers wherever it runs.

Pin-channel update (2026-08-31, issue #125): the committed role pins moved to the ZCode caching channel (`builtin:zai-start-plan/GLM-5.3-Flash`), which the DSH ollama provider does not serve — the 2026-08-29 verification above applied to the former `ollama/*` pins. Running the loop on DSH now requires re-establishing pin resolution first: declare/serve the pinned id in `~/.dsh/settings.yaml` if the ollama.com catalog carries it, else re-pin per ADR-0005 (a pin or provider change, never a silent reroute), then run `bun run dsh:preflight` before any model-pinned dispatch.

## Workspace isolation (parallel implementers)

DSH subagents inherit the session cwd and branch. Give each a gitignored worktree off the integration branch (`git worktree add -b agent/<slug> .worktrees/<slug> main`) and require in the prompt: prefix EVERY `read`/`write`/`edit`/`glob`/`grep` path with the worktree's absolute path (an unprefixed relative path lands in the main tree), pass `workdir: "<worktree>"` on EVERY bash call (each call is a fresh shell), and touch nothing outside it. Telling a subagent to `cd` isolates nothing. When the branch is merged, clean up with `bun run worktree:clean`.

## Worktree role-pin resolution (audited against ZCode's cwd trap)

ZCode resolves a child's role definitions (`.zcode/agents/<role>.md`) from the parent subagent's working directory, so a worktree parent whose committed pins lack a provider key fails every role-typed child spawn silently (see ZCode adapter, "The worktree role-pin trap"). **This gap is closed on DSH — not applicable by construction.** DSH parses no agent-definition files and has no named subagent types: there is no harness-side role resolution at spawn to get a cwd wrong. Generic `subagent` children always inherit the session model, and pins reach a child only through a `workflow` `agent()` override that the dispatcher assembles explicitly (§ Model routing) — the pin's source is the dispatcher's decision, never the child's cwd.

One residual cwd dependence remains, and it is visible rather than silent: `dsh:prompt` and `dsh:preflight` resolve `.zcode/agents/` from the script's own location, so run from a worktree they read that worktree's **committed** role bodies and pins — the session workspace's uncommitted pin edits do not apply there. A role file missing from the worktree branch fails prompt assembly with file-not-found, and `dsh:preflight` gates the worktree's pins against the provider config before dispatch. Neither can strand a manager run with an unexplained spawn failure, so no workaround beyond the worktree doctrine above is required: run the preflight where the dispatch runs, and never commit a worktree-local pin patch to the branch (ADR-0005 decision 3).
