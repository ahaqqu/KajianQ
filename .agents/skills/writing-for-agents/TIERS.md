# Skill tiers & provenance

Template-authored extension to [`SKILL-MECHANICS.md`](SKILL-MECHANICS.md): how skills in this template are classified and where they come from. The craft of writing them lives in the vendored reference; this file holds only this template's conventions.

## Tiers

Every skill is one of two tiers, defined by **who may start it** — never by directory location. Semantics live in metadata and prose (portable across harnesses, which enforce only the invocation flag), not in where the folder sits.

- **Entry skill** — startable on its own: the user types it, an orchestrator dispatches it, or the agent auto-fires it from a trigger-rich description. Entry skills are what the project's instruction file (e.g. `AGENTS.md`) indexes.
- **Library skill** — reached only through a parent: an entry skill's step, a role agent, or a spawned agent's dispatch. Never started directly. Mechanics:
  - First line of the body, right under the title: `> **Library skill** — not an entry point. Reached only through <parents>.` The pointer's **wording** is the mechanism — naming the parents is what makes agents route correctly.
  - **Description stripped of trigger phrases** — it states what the skill *is* and who loads it, never "Use when…". No triggers, no autonomous firing.
  - **Not indexed in the instruction file** — referenced only by relative path from its parents. Invariant: the library header's presence, not any directory, decides the tier.
  - `disable-model-invocation: true` only when nothing auto-loads it — verify first that the consumers that need it (e.g. a role agent's `skills:` field) still load a flagged skill.
- **Vendored skills** — synced from an upstream source — are exempt from *body* edits: keep the body byte-faithful so upstream syncs stay trivial, and declare their tier at the consumption sites (the parent skills and role agents that reach them) instead.

## Provenance fields

Every `SKILL.md` frontmatter declares where the skill came from and its sync state, so origin and staleness are checkable per file:

- `source:` — where this repo's copy syncs from: a blob URL of the sync source (for vendored skills the upstream original; in a fork, usually the template repo's copy of the skill), or `project` for skills authored in this repo.
- `upstream:` — the deepest known origin's blob URL, when the content originally came from outside the sync source (e.g. [mattpocock/skills](https://github.com/mattpocock/skills), [cursor/plugins](https://github.com/cursor/plugins)). Omit when the sync source is the original author.
- `modified:` — `true` when this repo's copy intentionally diverges from `source` (adaptation or override); `false` when byte-identical to it. Omit for `source: project`.
- `synced:` — date the copy was last compared against `source`/`upstream`. A staleness check is: fetch the current upstream, diff, update `synced`.

Provenance frontmatter is the *only* addition permitted to a vendored skill's frontmatter/body contract: never edit a vendored body, and never add fields whose loss a sync would make ambiguous.
