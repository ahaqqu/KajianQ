# ADR-0046: A trap question accepts a refusal or a grounded answer — refuse it, or ground it

## Decision

For a trap question — one whose expected behaviour is a refusal — two renderings are accepted: **refuse, or ground it.** A refusal passes on being a refusal: its signal is a trace refusal event or one of the caller-supplied refusal markers.

A non-refusal passes only when at least one citation is verified by evidence the pipeline already produces, read in one precedence. The server-derived citations frame comes first: a non-empty frame means the server grounded at least one of the answer's own inline citation spans against a trace-retrieved chunk, and an empty frame is authoritative, so the trace's reviewer-grounding labels are never consulted past it. Those labels decide only when the frame is absent, as on an older trace: a non-empty list grounds the answer, and an empty list is a real value, never "absent". There is deliberately no answer-text fallback. A non-refusal with no verified citation fails.

An answer question is unchanged: over-refusal stays a deterministic failure, grounded or not. The rule is general over every trap question, with no per-question vocabulary, acceptance block or detector.

## Why

The acceptance was what needed fixing, not the answer. A trap asks whether the pipeline declined, or grounded itself rather than fabricated, and two renderings answer yes; coupling pass and fail to one rendering's exact prose made the gate measure the model's phrasing, which is not a trust property. A refusal carries no citations by design, so requiring grounding would fail correct refusals. The liveness clause is what makes the loosening honest: the question's citation and recall legs are satisfied trivially, so accepting any non-refusal would make it a question that cannot fail — a gate reporting green while testing nothing. The text alone is not evidence, because a fabricated citation is citation-shaped, so a text path would let an invented label ground its own answer into a pass. Only existing signals are used, so the scorer cannot disagree with the citation gate: it reads the gate's own labels.

Rejected: a per-question acceptance block with a bespoke detector, which does not generalize to the next trap and would make eval-time acceptance stricter than runtime behaviour, protecting the grader rather than users; a paraphrase-tolerant refusal detector, because no bounded list of paraphrases exists and every added string is product vocabulary smuggled into a domain-agnostic engine package; requiring an answer to both decline and be grounded, since "declines" is not machine-detectable without exactly that vocabulary. Deferred, and recorded as the direction if prose matching resurfaces: having the pipeline declare its outcome for the grader to compare, which removes prose matching from the loop at the cost of changing the reviewer contract and the answer record.

## Consequences

- The acceptance stops coupling the trap to phrasing and the trap stays live: the canonical refusal, a grounded decline and any other grounded answer pass, while a non-refusal with no verified citation fails.
- It stays falsifiable: an empty frame, an empty grounding list, an older trace without the field even when the prose is citation-shaped, and a fabricated citation the frame does not ground are all pinned as failures.
- Accepted residual: a grounded but dated answer passes, so a prohibition on asserting a demanded-but-absent value is prompt-enforced only, machine-checked at neither runtime nor grading time — a recorded trade, not an oversight.
- The runtime mandate is untouched: the generator is still told to emit the canonical refusal and the reviewer still fails a decline-to-answer draft onto a refusal. This record only stops the gate depending on them.
- Adding a trap question remains an owner decision under the human curation gate; what this removes is the extra acceptance machinery adding one would otherwise require.
