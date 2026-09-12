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
**Definition:** What a Provider returns per call: the output (generated text, a stream of text, or embeddings) plus the call's metered cost record (model identity, tokens in/out, latency, cost in micro-USD); when the vendor reports no usage the record is estimated and marked as such, never presented as metered.
**Also known as:** completion, response (both vendor-shaped; ours is seam-shaped)

### Smoke Script

**Type:** command
**Context:** LLM provisioning (ops)
**Definition:** The CLI that exercises every keyed vendor through the Provider seam (generate + embed), prints a per-call cost table, and drills the fallback chain; vendors without an env key are reported `NOT RUN` without failing the run.
**Also known as:** provider smoke test, vendor check

### RagStore

**Type:** entity (interface)
**Context:** persistence (engine seam)
**Definition:** The single structured-data persistence seam (`packages/infra`, contract per ADR-0008) for docs, chunks, traces, and sessions; Effect-signatured (`Effect<A, StoreError, R>`) per ADR-0027 decision 7, with SQL confined to the Neon adapter and migrations.
**Also known as:** store (rejected — ambiguous with ObjectStore), database layer (rejected — implies consumers know SQL)

### ObjectStore

**Type:** entity (interface)
**Context:** persistence (engine seam)
**Definition:** The blob persistence seam (`packages/infra`) for raw exports and large artifacts; Effect-signatured per ADR-0027 decision 7, with vendor details (R2/S3) confined to adapters.
**Also known as:** blob store, file store (rejected — nothing is file-shaped at the seam)

### StoreError

**Type:** value object (tagged error union)
**Context:** persistence (engine seam)
**Definition:** The typed error channel of RagStore/ObjectStore — a closed kind set (`transport`, `timeout`, `constraint`, `not_found`, `config`) with the wrapped original in `cause`; defined in `packages/rag-core` (engine owns its seam vocabulary, mirroring `ProviderErrorKind`), mapped from vendor exceptions inside adapters.
**Also known as:** DB error, storage exception (rejected — leaks vendor types to consumers)

### Ingestion Pass

**Type:** command
**Context:** ingestion (engine)
**Definition:** One bounded execution of the ingestion pipeline over a declared collection range, which embeds and writes that range's children together; its cost is incurred once and is not recovered by re-running it.
**Also known as:** ingest run, batch (both rejected — they hide that the scope is declared and that the cost is not self-healing)

### Landed Collection

**Type:** value object
**Context:** ingestion (ops)
**Definition:** A corpus collection whose children are verifiably present in the store in the count the source declares; the unit by which ingestion scope is decided and a remaining corpus is measured.
**Also known as:** done collection, ingested collection (both rejected — "done" and "ingested" assert an intent that must instead be measured)

### Evidence Run

**Type:** event
**Context:** verification (ops)
**Definition:** A workflow run whose smoke result is cited as a pull request's evidence, distinguishable from probe and iteration runs by its deployed commit equalling the pull request head.
**Also known as:** gate run, CI run (both rejected — neither implies the sha equality that makes the result evidence)

### Corpus Snapshot

**Type:** value object
**Context:** ingestion (ops)
**Definition:** A labelled, immutable, restorable copy of a corpus-bearing store taken at a named checkpoint — before or after a paid ingest — held at both a provider layer and as a portable dump plus manifest, so no single provider, plan change, or deletion can lose the corpus.
**Also known as:** backup, dump (both rejected — "backup" hides the two-layer requirement, and "dump" names only the portable artifact rather than the checkpoint)
