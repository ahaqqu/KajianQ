# ADR-0006: Kitab is machine-translated at ingestion, labeled, with the Arabic always shown

## Decision

Every kitab chunk is machine-translated at ingestion into an Indonesian field stored beside the untouched raw text, and displayed as the Arabic original plus a translation carrying a visible machine-translation label.

Arabic is the canonical side of the pair: the Arabic text and its embedding are the index an answer cites against and the validator checks against. The translation is a display-layer artifact and a built-from-the-start retrieval fallback, never a peer, and it is never the basis for retrieval or scholarly reasoning.

## Why

The corpus's classical kitab are the product's moat and almost none carry an Indonesian translation, while the audience does not read Arabic. Two alternatives were rejected. Indonesian summaries only: a paraphrase cannot be cited, so it defeats strict citation. Ingesting only kitab that already have a translation: nearly none do, so the moat would be given up for a language the audience reads.

Mistranslation is the accepted cost, mitigated rather than hidden — the visible label, the Arabic that is always present, and translation checks in the eval harness. The reader is told what they are looking at, and the text an answer cites is the Arabic.

## Consequences

- The raw source stays immutable at every step: cleaning and translation write new fields, never the source.
- The citation validator resolves against the Arabic; a translation's presence is a label the interface renders, not a claim of authority.
- Which of the two tracks serves retrieval is the embedding benchmark gate's decision (ADR-0036).
- **Revisit when** a human-checked translation layer lands in the corpus: the label's meaning moves with a per-chunk provenance field, never with data mutation alone.
