# Glossary — KajianQ & DARS

Canonical terms beyond `CONTEXT.md`, captured per the domain-modeling discipline. `CONTEXT.md` remains the domain glossary for the product vocabulary; this file holds engine-layer terms that cross packages and need one name. Create entries lazily — only when a term is resolved and load-bearing.

### Provider

**Type:** entity (interface)
**Context:** LLM provisioning (engine)
**Definition:** The single typed seam in `rag-core` for all LLM/embedding calls — `generate`, `stream`, `embed` — whose results carry a `CostRecord`; vendor implementations live behind it in `packages/infra`.
**Also known as:** LLM client, vendor gateway, model adapter (all rejected — the seam is defined by what stages call, not by what wraps a vendor)

### Model Role

**Type:** value object
**Context:** LLM provisioning (engine)
**Definition:** A named pipeline slot (`generator`, `reviewer`, `cheap`, `embedder`, `translation`) resolved to a concrete provider/model/pricing entry via the provider config; `RunConfig.models` overrides per run with opaque model ids.
**Also known as:** tier (rejected — implies ordering the roles don't have), stage model (ambiguous with the pipeline Stage list)

### Provider Config

**Type:** aggregate (config)
**Context:** LLM provisioning (engine)
**Definition:** The checked-in JSON file (validated by a Valibot schema) that is the single source of truth for vendor endpoints, model ids, api-key env names, prices per MTok, and per-role fallback candidates; the `model_configs` DB table mirrors it for admin display.
**Also known as:** model_configs (reserved for the DB mirror table), provider registry

### Fallback Chain

**Type:** value object
**Context:** LLM provisioning (engine)
**Definition:** The ordered candidate list behind a Model Role, walked forward on transport errors, 429, and 5xx; the `CostRecord` of the call carries whichever candidate actually answered, and an exhausted chain throws a typed `ProviderError`.
**Also known as:** retry chain (rejected — retry implies re-calling the same vendor), failover (rejected — implies infra-level health switching)

### Provider Call Result

**Type:** value object
**Context:** LLM provisioning (engine)
**Definition:** What a Provider returns per call: the output (text, stream, or embeddings) plus the `CostRecord` (model id, tokens in/out, latency, computed cost in micro-USD) the caller must record to the run's trace sink.
**Also known as:** completion, response (both vendor-shaped; ours is seam-shaped)

### Smoke Script

**Type:** command
**Context:** LLM provisioning (ops)
**Definition:** The CLI that exercises every keyed vendor through the Provider seam (generate + embed), prints a per-call cost table, and drills the fallback chain; vendors without an env key are reported `NOT RUN` without failing the run.
**Also known as:** provider smoke test, vendor check