# ADR-0013: Arabic is the canonical evidence, Indonesian the query and output channel

## Decision

1. **Arabic is the canonical evidence layer.** The corpus, the reasoning and the citation rest on the Arabic text, and the citation validator checks against it.
2. **Indonesian is the user's channel:** the query arrives in it and the answer leaves in it. The model reasons over Arabic evidence, instructed in English, and answers in Indonesian.
3. **Retrieval is cross-lingual by design** — an Indonesian query retrieves Arabic chunks directly.
4. **The dual-index schema is built from the start** — the Arabic track the answer cites against, and an Indonesian track held as a fallback — so the retrieval posture is switchable in the store's query layer without re-ingestion.
5. **The retrieval posture is the embedding benchmark gate's decision** (ADR-0036), not this record's: the gate measures cross-lingual recall from the Indonesian track to the Arabic one, and monolingual recall within the Arabic track, over the real sources.

## Why

The corpus is classical Arabic — Quran, hadith with sanad, kitab — while the users are Indonesian-first and the engineering reasoning happens in English: three languages with three different jobs. Treating a translation as a peer retrieval source inverts the trust model, because fiqh, usul, hadith grades and madzhab terminology depend on exact Arabic wording, and a model reasoning over a translation is reasoning over an interpretation; citation matching and sanad precision degrade with it.

Rejected: storing and retrieving Arabic only, which forces a perfect Arabic query translation at the entry point — a brittle failure mode in front of the user; storing and retrieving the translation only, which maximizes usability and destroys trust; a concatenated bilingual embedding that treats the translation as a peer of the original.

## Consequences

- The benchmark gate's metric is explicitly Indonesian query → Arabic chunk recall with an Arabic baseline, not a monolingual test.
- Machine translation is still produced, stored and labeled, but it is not trusted as evidence.
- Structured reasoning and safety instructions may be written in English; the candidate evidence pool stays Arabic.
- **Revisit when** the gate shows the Arabic track alone misses the recall bar and a fusion posture is wanted — the fallback track is already built for it.
