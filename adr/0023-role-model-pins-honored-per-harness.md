# ADR-0023: Role-agent model pins are the single source of truth, honored per harness

## Status

Accepted (2026-08-29). Records the model-routing decision for the manager-orchestrated agentic workflow (#96, PR #98). Builds on ADR-0009 (price weighed in every model decision) and the template-sync ownership rules in `template-sync.json`.

## Context

The manager skill (`.agents/skills/manager/SKILL.md`) dispatches six role agents defined in `.zcode/agents/*.md`, each with a `model:` pin in its frontmatter. The repo runs two harnesses (README "Agentic development"): **ZCode**, which parses those files natively and resolves pins through its override order, and **DSH (DeepSeek Harness)**, which parses none of them.

Verified against the installed DSH (live probes, 2026-08-29): `subagent` children always inherit the session model (no per-call model parameter, no `subagent_type`); the `workflow` tool's `agent(prompt, { provider, model })` override is the only model-facing per-agent route and its children are one-shot (no continuation); nested spawns work from both plain-subagent and workflow children, so the reviewer can dispatch its two sub-reviewers from either. An initial probe round showed `glm-5.3` failing on DSH while ids declared in the DSH provider's model list dispatched — root cause was a missing declaration, not an upstream gap: ollama.com serves `glm-5.3` (catalog-verified), and after declaring it in `~/.dsh/settings.yaml` (hot-reloaded) the pin routes. Every template pin now dispatches on DSH. Issue #96's earlier non-goal ("no changes to the pinned role models") predates this owner request to make DSH work for every ZCode-configured role.

## Decision

1. **`.zcode/agents/<role>.md` frontmatter `model:` is the single source of truth for role models on every harness.** Model identity is never duplicated into skills, prompts, or per-harness role variants. The *mechanism* of honoring a pin is per-harness; the *value* travels from one file.
2. **Every harness honors the pin.** ZCode does so natively (override order: user → project pin → template default; adapter: `.agents/skills/manager/ZCODE-ADAPTER.md`). DSH does so through its adapter (`.agents/skills/manager/DSH-ADAPTER.md`): at dispatch, read the pin, translate `ollama/<model>:cloud` → `{ provider: "ollama", model: "<model>" }`, then dispatch — plain `subagent` (continuable) when the pinned model equals the session model, otherwise a `workflow` `agent()` call (one-shot; a CI-red relay respawns a fresh agent carrying the failing logs instead of resuming).
3. **A pin that fails to resolve on a harness is a harness-config gap, fixed in the harness's own configuration — never rerouted to a different model.** On DSH the fix ships as a script, not wording: the preflight gate `bun run dsh:preflight` (`scripts/dsh-pin-check.mjs`) reads every role pin from `.zcode/agents/`, checks each model id against the provider's declared models (`~/.dsh/settings.yaml`) and the ollama.com catalog, and exits non-zero with the fix; `--fix` appends missing declarations. Per-harness fallback models are rejected: they fork the pin truth, make the DSH run silently weaker than the pin declares, and bury the deviation inside skills. The role files keep their template pins untouched (template-sync conflicts avoided). Skill and adapter files record no fallback tables — the *absence* of routing deviations is the invariant; the gate's exit code is the check, and probe evidence and dates live in this ADR and the PR, not in skills.
4. **Cost discipline (ADR-0009) holds:** all ids stay on the existing ollama provider on the current Pro plan — no new vendor, no free-tier routing of anything sensitive.

## Consequences

- All six ZCode-configured roles run end-to-end on DSH with **their exact pinned models** — verified by probe on 2026-08-29 after the provider declaration; the DSH adapter documents no routing deviations.
- Model changes remain one-file edits: change a pin and (on DSH) re-probe routing with the one-agent probe; a failure is fixed by declaring the id in harness config, in the same change.
- Workflow-pinned dispatches are one-shot; the manager compensates by respawning fresh with logs, so continuation is never silently lost — it changes form per dispatch type.
- Skills carry no routing status, fallback tables, or support-status sections that can go stale; their only routing claim is the dispatch rule and the config-fix procedure.

## Revisit triggers

- A role pin changes in `.zcode/agents/`: re-probe the new id on DSH before the next manager run; if it fails to resolve, declare it in the DSH provider config rather than rerouting.
- A harness upgrade changes model-resolution behavior: re-run the probe suite (spawn, continuation, nested-from-workflow, per-pin routing) before trusting the loop.
- A third harness is adopted: give it an adapter file in the manager skill and its own pin-honoring rule — the pin file does not move.