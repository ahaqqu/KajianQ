# ADR-0058: A citation label the question names is a deterministic retrieval arm

## Decision

1. **A citation label in the verbatim question is a retrieval arm beside the fused hits, never a re-ranking.** The chunks whose stored identity the label addresses are read directly and added alongside the semantic candidates, because a label is an identifier rather than a topic. Detection runs on the caller's question, not on a router sub-query, so a paraphrase cannot move it.
2. **Detection and address extraction are domain logic.** The domain pack's citation grammar recognises the label and maps it onto the structural identity the corpus stores at ingest. The engine receives only opaque metadata key/value pairs, an origin label and a typed trace event, and issues one generic exact-match read. A form that names no single stored address — an un-ingested work, an unenumerable range, a collection the corpus does not carry — is not resolved.
3. **The arm is bounded by a configurable cap.** `LABEL_LOOKUP_CAP` is a non-negative integer; zero disables the arm, a malformed value is a typed config failure, and both the read and the chunks added are bounded.
4. **A label the corpus does not carry adds no chunk.** The lookup reads stored rows; it never renders a passage from the parsed string, so the generator is never handed the label as evidence and the canonical refusal remains the delivered answer. The typed event records the labels named, the labels no row carried, what was returned and whether the budget truncated.
5. **The trace says which arm produced every candidate.** Lookup chunks carry their own origin label, distinct from the fused hits and from the other deterministic reads, and the event grows the trace contract additively.

## Why

A user who cites an exact reference writes the product's most well-posed question. Dense retrieval ranks by topic, and an exact number carries no topic signal: the passages around the named one can outscore it, so the requested label never reaches the generator and a refusal says the corpus lacks evidence it holds. Treating the label as a similarity problem rephrases an identity the user already stated, and a sub-query that merely includes the label verbatim still competes with the neighbours that outrank it. A directed read of the stored identity is what makes the evidence's presence deterministic.

The refusal direction is load-bearing: an exact-looking label is easy to fabricate, so the arm must be able to return nothing. Reading rows rather than rendering the parsed label keeps "the corpus carries it" as the condition for evidence.

Rejected: embedding the label or its number (an identifier has no semantic neighbourhood to improve); a reranker over the fused set (the requested row is not in the set to rerank); a schema or label-index addition (the corpus already stores the identity in its metadata, so a new index would speed a read that is not the bottleneck); and trusting the generator to quote a label it was shown only in the question.

## Consequences

- An answerable exact-reference question now cites its passage; an unanswerable one still refuses, and its trace shows the lookup ran and found nothing.
- The read is bounded and adds no schema, so there is no migration and no re-ingestion.
- Cost rises by at most the cap in prompt plus one store read per named label; a question with no label pays neither a read nor an event.
- The trace contract grows additively, so persisted traces and older frames still parse, and the store seam gains one exact-match read every adapter must implement.
- The eval's fused-only leg already excludes every origin-labelled path, so the arm's contribution is visible in the scored recall and in its own trace event, never folded into another expansion's count.
- **Revisit when** a collection spelling the registry does not carry matters (a spelling row, not a fuzzy match); a label addresses several rows and the cap truncates the set the user meant; the hadith grammar's spaced range form is asked for; or a second product needs a label vocabulary the generic metadata read cannot express.
