# ZCode adapter — dispatching the manager's roles on ZCode

The manager skill (`SKILL.md`) is harness-neutral; this file is its **ZCode adapter** — the reference harness this workflow was designed for. Load it only when running the manager loop on ZCode. The role files and their model pins live in `.zcode/agents/<role>.md` — the single source of truth for role models on every harness; on ZCode the harness parses them natively, so the adapter is thin.

Mechanics per ZCode's native behavior (this is the template's reference adapter — verified by the template's own design and daily use rather than by a probe suite):

- **Spawn:** each role is a named `subagent_type` (`implementer`, `senior-implementer`, `reviewer`, `assistant-manager`) defined in `.zcode/agents/`, dispatched with background run. The definitions and model pins resolve automatically — no prompt assembly or role-body inlining needed.
- **Resume:** continue a child with `SendMessage` (manager steps 2 and 5); re-issue its prompt verbatim when respawning after a stall.
- **Results:** read a child's report from its final message. `TaskOutput` on a subagent exposes a transcript symlink, not a report — do not read it for the result or you will overflow your context.
- **Model routing:** resolved by ZCode from the pin files' `model:` frontmatter — override order: `~/.zcode/agents/<role>.md` (user) → this project's `.zcode/agents/` → template pin (see the pinned-defaults table in the role registry). Nothing to map at dispatch time; a model-pinned dispatch keeps `SendMessage` continuation.
- **Approvals and isolation:** subagent approval and workspace-isolation mechanics follow the `subagent` skill (§ Workspace isolation) — it is harness-neutral by design.