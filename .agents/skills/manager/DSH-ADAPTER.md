# DSH adapter — dispatching the manager's roles on DeepSeek Harness

The manager skill (`SKILL.md`) is harness-neutral; this file is its **DSH (DeepSeek Harness) adapter** and the single home for DSH dispatch mechanics, model routing, and their verification. Load it only when running the manager loop on DSH. The role pins live in `.zcode/agents/<role>.md` (single source of truth for both harnesses — ADR-0023); this file defines how DSH honors them.

Verified against the installed DSH by live probes (2026-08-29): foreground and background (continuable) spawn, `send_message` continuation, nested spawns **including from workflow children** (the reviewer pattern), and per-agent model overrides via `workflow`.

## Dispatch recipe — all six roles

DSH has no named agent types and no agent-definition files, so the role definition travels in the prompt:

| Role | DSH dispatch |
| --- | --- |
| A — implementer | generic `subagent`, background (durable id); role body from `.zcode/agents/implementer.md` inlined into the prompt. Continue with `send_message` for the CI-fix relay (a workflow-pinned dispatch respawns fresh instead — see Model routing). |
| A — senior-implementer | same, body from `senior-implementer.md`; model honored via the routing rule below. |
| B — reviewer | generic `subagent`, background; body from `reviewer.md` inlined. It spawns its two sub-reviewers itself (nested spawn verified). |
| sub-reviewer (security) | child generic `subagent` with the baseline prompt from `thermo-nuclear-review/SKILL.md` inlined — DSH has no subagent types for them; this is the fallback `thermos-with-comments` already allows. |
| sub-reviewer (quality) | child generic `subagent` with the baseline prompt from `thermo-nuclear-code-quality-review/SKILL.md` inlined. |
| C — assistant-manager | generic `subagent`, background; body from `assistant-manager.md` inlined. Read-only is enforced by the role body's constraints — DSH exposes no per-call tool filter. |

## Mechanics

- **Spawn:** `subagent` with a complete, standalone prompt = task + role body + the skill to apply. Result arrives as a settle notice; the id stays continuable.
- **Resume:** `send_message` to the subagent id (manager steps 2 and 5); list with `list_agents`; cancel a stalled turn with `interrupt_agent`.
- **Approvals:** DSH subagents run with their approval policy pinned to `never` — a rejected operation is a blocker to report, never a retry.

## Model routing (ADR-0023)

The pin in each role file's frontmatter is the single source of truth, and the DSH adapter honors it for **every** dispatch: read the pin, translate `ollama/<model>:cloud` to `{ provider: "ollama", model: "<model>" }`, resolve the effective model against the routing status below (unroutable ids map to their recorded fallback), then dispatch — plain `subagent` (continuable) when the effective model equals the session model, otherwise a `workflow` `agent()` call. The `subagent` tool itself has no per-call model override — children inherit the session model.

Routing status, verified by probes on this install (2026-08-29):

| Pin (roles) | Routes on DSH | Effective DSH model |
| --- | --- | --- |
| `ollama/glm-5.3-flash:cloud` (implementer) | yes (session default) | `glm-5.3-flash` |
| `ollama/glm-5.3:cloud` (senior-implementer, thermo-nuclear-review-subagent) | **no** — child resolves `null` | fallback `glm-5.2` (ADR-0023) until it routes |
| `ollama/kimi-k2.7-code:cloud` (reviewer, thermo-nuclear-code-quality-review-subagent, assistant-manager) | yes | `kimi-k2.7-code` |

Trade-offs, verified:

- `workflow` runs in the foreground and its children are one-shot — a model-pinned implementer cannot be resumed with `send_message`; when its CI goes red, spawn a fresh workflow agent carrying the failing logs.
- Nested spawn works from `workflow` children too (probe-verified), so the reviewer keeps dispatching its two sub-reviewers wherever it runs.
- `deepseek-v4-flash:0731` also does not route; no role pins it today — a pin on an unrouted id means "re-probe before dispatch", never silent session-model drift.

## Workspace isolation (parallel implementers)

DSH subagents inherit the session cwd and branch. Give each a gitignored worktree off the integration branch (`git worktree add -b agent/<slug> .worktrees/<slug> main`) and require in the prompt: prefix EVERY `read`/`write`/`edit`/`glob`/`grep` path with the worktree's absolute path (an unprefixed relative path lands in the main tree), pass `workdir: "<worktree>"` on EVERY bash call (each call is a fresh shell), and touch nothing outside it. Telling a subagent to `cd` isolates nothing. When the branch is merged, clean up with `bun run worktree:clean`.

## Support status

- ZCode is the reference adapter: its pins resolve inside ZCode (see `.zcode/agents/README.md`).
- DSH runs the manager loop end-to-end for **all six ZCode-configured roles with their pins honored** — spawn, nested review (from plain subagents and from workflow children), `send_message` continuation, and per-pin model routing are probe-verified — with two recorded deviations: role bodies are inlined rather than name-resolved, and the `glm-5.3` roles run on the `glm-5.2` fallback until that id routes (ADR-0023).