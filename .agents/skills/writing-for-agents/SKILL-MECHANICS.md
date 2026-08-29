# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill strips the description from the agent's reach: only the human typing its name can invoke it, and no other skill can. Zero context load, but it spends cognitive load: you are the index that must remember it exists. Mechanics: set `disable-model-invocation: true`; the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

Shared reference that two user-invoked skills both need can live in neither: with no descriptions, neither can fire the other. Push it to a plain file outside the skill system: external reference any skill can point at.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills have no description, so nothing but the human can reach them.

## Multiple harnesses

A project can run its agentic skills on more than one harness (this repo: ZCode and DeepSeek Harness). The writing rules generalize there:

- **Cut on the adapter boundary, and only there.** Per-harness mechanics (spawn/resume/model/isolation) go into a per-harness **adapter file**, reached by a router pointer in the shared body that the agent resolves from its own spawn tools (see the `manager` skill's *Harness adapters* router → `DSH-ADAPTER.md` / the ZCode adapter README) — so a session loads only its own branch. The loop itself, the shared role config, and workflow steps stay single-sourced: splitting behavior forks the protocol and every future change gets made twice. A harness-specific mechanic stated in the shared body is a variance bug: runs on the other harness take a path the text does not describe.
- **One configurable fact, one file.** A role's persona and model pin live in the agent-definition file the harness parses. A harness that parses no such files can still honor the same file through a documented dispatch rule — read the value at dispatch, translate it per the declared mapping, fall back visibly when the value cannot run — written next to a pointer to the file it reads, named as the source of truth (ADR-0023; `.zcode/agents/` stays the pin home for both harnesses).
- **Verified ≠ documented.** A harness claim (a tool's parameters, a model id routing, a nested spawn) is verified only by running it on the installed harness: record the probe and its date, and state the recorded fallback for what fails. An unverified recipe documented as supported is a false completion criterion.
- **Per-harness deviations are configuration, recorded in one place.** A dated routing/fallback table in that harness's adapter file beats both silent drift and edits to the shared files — template-synced pins stay untouched, and the deviation stays auditable (ADR-0023's rationale).
