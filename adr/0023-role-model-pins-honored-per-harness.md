# ADR-0023: Role-agent model pins are the single source of truth, honored per harness

## Status

Accepted (2026-08-29). Records the model-routing decision for the manager-orchestrated agentic workflow (#96, PR #98). Builds on ADR-0009 (price weighed in every model decision) and the template-sync ownership rules in `template-sync.json`.

## Context

The manager skill (`.agents/skills/manager/SKILL.md`) dispatches six role agents defined in `.zcode/agents/*.md`, each with a `model:` pin in its frontmatter. The repo runs two harnesses (README "Agentic development"): **ZCode**, which parses those files natively and resolves pins through its override order, and **DSH (DeepSeek Harness)**, which parses none of them.

Verified against the installed DSH (live probes, 2026-08-29): `subagent` children always inherit the session model (no per-call model parameter, no `subagent_type`); the `workflow` tool's `agent(prompt, { provider, model })` override is the only model-facing per-agent route and its children are one-shot (no continuation); nested spawns work from both plain-subagent and workflow children, so the reviewer can dispatch its two sub-reviewers from either. Routing by id: `kimi-k2.7-code`, `kimi-k3`, `glm-5.2`, and the session default (`glm-5.3-flash`) dispatch successfully; **`glm-5.3` and `deepseek-v4-flash:0731` reproducibly fail** (the child resolves `null`). Consequently two template pins — `senior-implementer` and `thermo-nuclear-review-subagent`, both `ollama/glm-5.3:cloud` — execute on ZCode but cannot route on DSH as-is. Issue #96's earlier non-goal ("no changes to the pinned role models") predates this owner request to make DSH work for every ZCode-configured role.

## Decision

1. **`.zcode/agents/<role>.md` frontmatter `model:` is the single source of truth for role models on every harness.** Model identity is never duplicated into skills, prompts, or per-harness role variants. The *mechanism* of honoring a pin is per-harness; the *value* travels from one file.
2. **Every harness honors the pin.** ZCode does so natively (override order: user → project pin → template default; adapter: `.agents/skills/manager/ZCODE-ADAPTER.md`). DSH does so through its adapter (`.agents/skills/manager/DSH-ADAPTER.md`): at dispatch, read the pin, translate `ollama/<model>:cloud` → `{ provider: "ollama", model: "<model>" }`, resolve the effective model against the DSH routing table there, then dispatch — plain `subagent` (continuable) when the effective model equals the session model, otherwise a `workflow` `agent()` call (one-shot; a CI-red relay respawns a fresh agent carrying the failing logs instead of resuming).
3. **Unroutable ids carry a recorded per-harness fallback, written as configuration, not changed template pins.** The role files keep their template pins (forks and ZCode are unaffected; template-sync conflicts are avoided). The DSH adapter maps a pin it cannot route to a verified alternative — today `glm-5.3` → `glm-5.2`, the strongest high-reasoning model verified to route on DSH. The mapping lives in `.agents/skills/manager/DSH-ADAPTER.md` (§ Model routing) with the probe date; a harness that cannot execute the configured pin says so there, in one auditable place.
4. **Cost discipline (ADR-0009) holds:** all ids stay on the existing ollama provider on the current Pro plan — no new vendor, no free-tier routing of anything sensitive; the fallback trades a marginally different model tier for the verified ability to run at all.

## Consequences

- All six ZCode-configured roles run end-to-end on DSH with their pins honored — via the pinned model where it routes, via the recorded fallback where it does not — with the deviation visible in the DSH adapter file and dated.
- Model changes remain one-file edits: change a pin and (on DSH) re-verify routing with the one-agent probe before dispatching a real run.
- Workflow-pinned dispatches are one-shot; the manager compensates by respawning fresh with logs (already the documented mechanism), so continuation is never silently lost — it changes form per dispatch type.
- The routing table is a cache of probe results, not of the pins; it can go stale in either direction and must be re-verified whenever the pins, the provider route, or the DSH model list change.

## Revisit triggers

- Ollama/DASH routes `glm-5.3` (or `deepseek-v4-flash:0731`) on DSH: drop the fallback row and re-verify.
- A role pin changes in `.zcode/agents/`: re-probe the new id on DSH before the next manager run; update the routing table row in the same PR.
- A third harness is adopted: give it an adapter branch in the manager skill and its own pin-honoring rule — the pin file does not move.