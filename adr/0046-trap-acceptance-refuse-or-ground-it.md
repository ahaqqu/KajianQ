# ADR-0046: Trap questions accept a refusal or a grounded answer — refuse it, or ground it

## Decision

For a trap question — one whose expected behaviour is a refusal — two renderings are accepted: **refuse, or ground
it.** A refusal passes on being a refusal, because it carries no citations by design and requiring grounding would
fail correct refusals; its signal stays a trace refusal event or one of the caller-supplied refusal markers.

A non-refusal passes only when at least one citation is verified by evidence the pipeline already produces, read in
one precedence. The server-derived citations frame comes first: a non-empty frame means the server grounded at least
one of the answer's own inline citation spans against a trace-retrieved chunk, and an empty frame is authoritative, so
the trace's reviewer-grounding labels are never consulted past it. Those labels decide only when the frame is absent,
as on an older trace: a non-empty list grounds the answer, and an empty list is a real value, never "absent". There is
deliberately no answer-text fallback, because the text alone is not evidence — a fabricated citation is
citation-shaped, so a text path would let an invented label ground its own answer into a pass. A non-refusal with no
verified citation fails, which keeps the trap live. An answer question is unchanged: over-refusal stays a
deterministic failure, grounded or not. And the rule is general over every trap question, with no per-question
vocabulary, acceptance block, or detector.

## Why

The acceptance was what needed fixing, not the answer. A trap asks whether the pipeline declined, or grounded itself,
rather than fabricated — two renderings answer yes — and coupling pass/fail to one rendering's exact prose made the
gate measure the model's phrasing, which is not a trust property. The prompt's verbatim refusal sentence steadied the
generator but could not guarantee the prose the gate compared against. The liveness clause is what makes the loosening
honest. The question's citation and recall legs are satisfied trivially, so accepting any non-refusal would make it a
question that cannot fail, a gate reporting green while testing nothing; a verified citation keeps it a real test.
Only existing signals are used: the frame and the grounding labels are already persisted for every answer, so there is
no new reviewer output, contract change, prompt change, or spend, and the scorer cannot disagree with the citation
gate because it reads the gate's own labels. Rejected: a per-question acceptance block with a bespoke date detector,
which does not generalize to the next trap and would make eval-time acceptance stricter than runtime behaviour,
protecting the grader rather than users; a paraphrase-tolerant refusal detector, because no bounded list of
paraphrases exists and every added string is product vocabulary smuggled into a domain-agnostic engine package, while
the grounded branch needs none; requiring an answer to both decline and be grounded, since "declines" is not
machine-detectable without exactly the vocabulary this removes; and having the pipeline declare its outcome for the
grader to compare — the cleanest direction, which removes prose matching from the loop — deferred because it changes
the reviewer contract and the answer record for the same acceptance at a larger blast radius, and kept as the recorded
direction if prose matching resurfaces.

## Consequences

The acceptance rule stops coupling the trap to phrasing and the trap stays live: the canonical refusal, a grounded
decline, and any other grounded answer pass, while a non-refusal with no verified citation fails. It stays falsifiable
— ungrounded renderings are pinned as failures: an empty frame, an empty grounding list, an older trace without the
field even when the prose is citation-shaped, and a fabricated citation the frame does not ground. The evidence-supply
chain is code-verified but not observed end-to-end: whether a live paraphrase answer yields a non-empty frame is an
empirical property of the next staging smoke, not of the hermetic suite, and the ticket's closure is gated on that
observation. Residual, accepted: a grounded but dated answer passes, so the prohibition on asserting a
demanded-but-absent date is prompt-enforced only, machine-checked at neither runtime nor grading time. That is a
recorded trade, not an oversight — the machine date detector was built and rejected as a per-question detector that
does not generalize. The fabricated-attribution trap carries the same trivially-satisfied legs, so its acceptance
widens identically. Metric definitions do not change: recall, citation validity, the refusal flag, and the persisted
outcome shape are untouched, and historical rows are not re-scored. The refusal-detector coupling remains for answer
questions — that is the over-refusal check, and it is cheap. The runtime prompt mandate is untouched: the generator is
still told to emit the canonical sentence and the reviewer still fails a decline-to-answer draft onto a refusal. Those
protect users; this record only stops the gate depending on them. Adding a trap question is still an owner decision
under the human curation gate; what this removes is the extra acceptance machinery adding one used to imply.
