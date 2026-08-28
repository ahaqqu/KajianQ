# ADR-0013: Bilingual RAG with Arabic as canonical evidence, Indonesian as query/output channel

## Status

Accepted with amendments (2026-08-15). Arabic is the canonical evidence layer; Indonesian translation is a display-layer artifact, not a peer retrieval source. Retrieval is cross-lingual ID→AR by default, with an Indonesian fallback index held in reserve. ADR-0006 is amended accordingly (embedding is Arabic-first with Indonesian as fallback, not concatenation as peers). The three amendments below were adopted from the review:

1. **Build the dual-index schema (`embedding_ar` + `embedding_id`) from the start** in ticket #4, even if retrieval initially uses only one track. This trades ~2× vector storage for optionality and eliminates the re-embedding risk — the retrieval-layer choice (AR-only vs. fusion) is switchable in the RagStore query layer without re-ingestion.
2. **#9 is the explicit go/no-go gate for the retrieval posture.** It compares at least `gemini-embedding-001` and `gemini-embedding-2` on ID→AR and AR→AR recall over the real corpus. The retrieval-layer choice (AR-only vs. ID-fallback fusion) is decided by #9's numbers, not asserted here.
3. **ADR-0006 is updated now** to state embedding is Arabic-first with Indonesian as fallback, not peer concatenation.

This ADR amends the retrieval and embedding strategy without changing the UI/safety rules already in the spec.

## Context

KajianQ's corpus is classical Arabic (Quran Uthmani, hadith with sanad, pre-600 H kitab). Its users are Indonesian-first. The engineering team may reason in English. This creates a three-language problem:

- **Arabic:** source of truth for evidence, citation, sanad, and fiqh terminology.
- **Indonesian:** user query language and answer output language.
- **English:** likely best language for structured reasoning prompts and safety instructions.

Spec #1 requires strict citations, Arabic originals alongside every quote, machine-translation labels, and a deterministic citation validator. ADR-0006 already states that kitab chunks are LLM-translated into `text_indonesia` and concatenated with Arabic for embedding, with the Arabic original always shown. This ADR questions whether concatenation/translation should sit at the retrieval layer, or only at the display layer.

## Decision (proposed)

Arabic text is the **canonical evidence layer**. Indonesian translation is a **user-facing display convenience**, not a peer retrieval source. Retrieval is designed as explicit **cross-lingual search**: an Indonesian query retrieves Arabic chunks directly. The LLM reasons over Arabic evidence, instructed in English, and answers in Indonesian.

### Consequences if accepted

- The embedding benchmark gate (#9) becomes an explicit **Indonesian-query → Arabic-chunk recall** test, not a monolingual test.
- Schema gains first-class Arabic fields (`text_ar`, `embedding_ar`) as the primary evidence, with Indonesian (`text_id`, `embedding_id`) available only as an optional fallback/fusion channel.
- The citation validator checks citations against `text_ar`.
- Machine translation is still produced, stored, and labeled, but it is not trusted as the basis for retrieval or scholarly reasoning.
- Deep Think (#25) may use English chain-of-thought, but the candidate evidence pool remains Arabic.

## Alternatives considered

### A. Store and retrieve only Arabic (rejected)

Would maximize fidelity but fail usability: Indonesian users ask in Indonesian, and forcing perfect Arabic query translation before search adds a brittle failure mode at the entry point.

### B. Store and retrieve only Indonesian translation (rejected)

Would maximize usability but destroy trust. Fiqh, usul, hadith grades, and madzhab terminology depend on exact Arabic wording. A model reasoning over translation is reasoning over an interpretation, not the evidence. Citation matching and sanad/takhrij precision would degrade.

### C. Bilingual concatenated embedding, Arabic + Indonesian as peer sources (current ADR-0006 direction)

Better than A or B, but it treats translation as a peer of the original. The proposal refines this: Arabic is the canonical index; Indonesian is an auxiliary fallback used only if the cross-lingual Arabic model underperforms.

## Proposed language stack

| Layer | Language | Rationale |
|---|---|---|
| User query | Indonesian / English | Matches user. |
| Query expansion (#24) | Indonesian + Arabic variants | Glossary maps terms (`surga → jannah, firdaus`) without replacing the original query. |
| Retrieval index | Arabic primary; Indonesian optional fallback | Cross-lingual embedding should find Arabic evidence from an Indonesian query. |
| Evidence in LLM context | Arabic | Preserves citation fidelity, sanad, and scholarly terminology. |
| System prompts / structured reasoning | English | Usually gives crisper JSON, guardrails, and formatting. |
| Generated answer | Indonesian | User-first requirement from spec #1. |
| Citations | Arabic | `QS. Surah:Ayah`, `HR. Book no. N (Grade)`, `Kitab, Author, Vol:Page:Bab`. |

## Affected tickets and spec sections

| Ticket / doc | Current assumption | Proposed amendment |
|---|---|---|
| Spec #1, §Implementation Decisions (retrieval) | Hybrid dense + sparse; embedding model `gemini-embedding-001` gated by benchmark on real corpus. | Benchmark metric is explicit: Indonesian query → Arabic chunk recall, plus Arabic baseline. |
| #4 (Neon schema) | Single `VECTOR(1536)` on chunks (language unspecified). | Add `text_ar`, `embedding_ar` as canonical; `text_id`, `embedding_id` as **built-from-the-start** fallback/fusion track (not optional). Keep `text_raw`. The dual index is built up front so the retrieval-layer choice is switchable without re-embedding. |
| #6, #7 (Quran/hadith ingestion) | Arabic + Indonesian stored; concatenated for embedding. | Ingest Arabic as primary evidence. Indonesian translation is secondary metadata. |
| #9 (embedding benchmark) | Compare models on real corpus. | **Go/no-go gate.** Compare at least `gemini-embedding-001` and `gemini-embedding-2` on ID→AR and AR→AR recall over the real corpus. The retrieval-layer choice (AR-only vs. ID-fallback fusion) is decided by these numbers. |
| #10 (chat pipeline) | Citation validator checks retrieved chunks. | Validator checks against `text_ar`; generator sees Arabic evidence. |
| #21 (kitab tracer) | LLM-translated chunks stored alongside Arabic. | Sharh/matn separation and grading happen on Arabic text; translation is downstream display only. |
| #24 (terminology glossary) | ID↔AR variant map for expansion. | Same, but framed strictly as query enrichment that never replaces the original query. |
| #25 (Deep Think) | Draft answer → gap detection → re-retrieve. | Reasoning may be in English; candidate pool stays Arabic. Coverage report counts Arabic passages examined/used. |

## Relationship to existing ADRs

- **ADR-0006:** This ADR does not remove machine translation or the UI label. It demotes translation from a peer retrieval source to a display-layer artifact. If accepted, ADR-0006 should be updated to say embedding/indexing is Arabic-first with Indonesian as fallback, not concatenation as peers.
- **ADR-0008:** Strengthens the case for the RagStore adapter: it must now express a dual-track (Arabic primary + Indonesian fallback) vector and metadata schema, still behind the adapter boundary.

## Open questions for the reviewing agent / team

1. Does the chosen embedding model (currently `gemini-embedding-001`) demonstrate strong enough Arabic↔Indonesian cross-lingual recall to make a single Arabic index sufficient? If not, is a dual-index fusion acceptable?
2. Should `text_id` still be embedded by default, or only generated on demand if the benchmark fails?
3. How should parent-summary embeddings be handled: summarize Arabic and embed Arabic, or summarize Indonesian and embed Indonesian? The proposal favors Arabic summaries embedded in Arabic, with Indonesian summaries as display only.
4. Does storing `embedding_id` alongside `embedding_ar` create unacceptable storage/cost overhead for 10+ kitab and 650K hadith?
5. For kitab chunks, should the LLM context include only Arabic, or Arabic + Indonesian label? The proposal says Arabic only, with Indonesian shown to the user separately.

## Decision record (accepted 2026-08-15)

The canonical-evidence principle — Arabic is the source of truth for reasoning and citation, Indonesian is display — is accepted. The dual-index schema (`embedding_ar` + `embedding_id`) is built from the start in #4 for optionality. The retrieval-layer choice (AR-only vs. ID-fallback fusion) is deferred to #9's benchmark, which compares `gemini-embedding-001` and `gemini-embedding-2` on ID→AR and AR→AR recall. Do not start kitab-scale ingestion (#22, #33, #35) until #9 confirms the retrieval posture, because re-embedding is expensive.

## Open questions carried forward

1. Does `gemini-embedding-001` or `gemini-embedding-2` achieve adequate ID→AR cross-lingual recall? — decided by #9.
2. Is the Neon plan's storage tier sufficient for dual 1536-dim vectors across 6,236 ayah + 650K hadith + 10 kitab? — a quick cost calculation before #4 merges.
3. Parent-summary language (Arabic or Indonesian) for embeddings — decided by #9 (test both) and domain judgment.
