# ADR-0006: Kitab is LLM-translated at ingestion, labeled, with the Arabic always shown

## Decision

Every kitab chunk is machine-translated at ingestion into `text_indonesia`, stored beside the untouched `text_raw`,
and displayed as the Arabic original plus a translation carrying the label "Terjemahan mesin — lihat teks Arab asli".

Arabic is canonical evidence: `text_ar` / `embedding_ar` is the index the answer cites against and the citation
validator checks against, while `text_id` / `embedding_id` is a built-from-the-start fallback track and a display
layer, never a peer. Machine translation is not the basis for retrieval or scholarly reasoning.

## Why

The corpus's pre-600 H kitab are the product's moat and almost none have an Indonesian translation, while the audience
does not read Arabic. Two alternatives were rejected. Indonesian summaries only: a paraphrase cannot be cited, so it
defeats strict citation. Ingesting only kitab that already have an Indonesian
translation: nearly none do, so the moat would be given up for a language the audience reads.

Mistranslation is the accepted cost, mitigated rather than hidden — the visible label, the Arabic that is always
present, and faithfulness spot-checks in eval. The reader is told what they are looking at, and the text an answer
cites is the Arabic.

## Consequences

Translation is a display-layer artifact and an optional retrieval fallback; the citation validator resolves against
`text_ar`. `text_raw` stays immutable at every step: cleaning and translation write new fields, never the source.

Which of the two tracks serves retrieval is the embedding benchmark gate's decision (ADR-0036).
