# ADR-0055: A refusal is read twice before it ships

## Decision

A refusal is the generator's claim that the retrieved evidence cannot answer the
question. That claim is **shipped only when the generator reaches it twice**, on
the same assembled evidence: a pure refusal is reread, and the refusal is
delivered only when the reread is a pure refusal too.

Only that shape is reread: a draft that answers is never reread — a hybrid whose
grounded partial answer carries the sentence included — and the stage reads the
predicate its owner defines, never the sentence again.

The reread is the generator's own second reading, not a second refusal rule: the
deterministic classification, the citation gate, the reviewer and the trap
acceptance keep their single owner. The rule governs the code, not the model: a
refusal ships only when both readings decline, so the reread lowers a sampled
refusal's rate — a question that declines with probability p now refuses only
when both samples decline, near p² — but never eliminates it. An answer the
reread produces is judged by the gate, not the reread; a trap accepts it when it
grounds itself (ADR-0046), so that record's grounded-but-dated residual stays
reachable after a first decline.

A refusal costs one extra generation, and a draft the reread rescues costs one
too — the refused reading plus the shipped one — while a first-reading answer and
an empty context's refusal pay once. A reread that cannot be read leaves the first
refusal standing, its estimated spend on the trace, and both readings record
their model, tokens, latency and cost there.

## Why

The generator is a sampled model, and a refusal is one sample of a judgment about
the evidence. The same context, under the same prompt, can read as sufficient and
as insufficient; when it does, the refusal reports the sample as the evidence's
verdict. The prompt already makes present evidence an answer (ADR-0015), so what
is missing is a reading that must reproduce before it ships.

The alternatives fail in opposite directions. Treating the first refusal as final
makes every refusal a coin flip on a question the corpus can answer. Treating a
non-empty context as permission to answer is worse: it is not an answering
context — the trap class exists precisely there — so it ships answers the evidence
does not hold. A second reading is the smallest test: an earned refusal
reproduces, a sampled one does not.

Rejected: another refusal clause in the prompt, because the clause that makes
present evidence an answer is already there. Rejected: a deterministic "context is
non-empty, therefore answer" rule, which cannot separate evidence that addresses
the question from evidence that shares its topic, and would break the trap
questions. Rejected: a second model or a judge: a new vendor and a new gate for a
sampling problem the same model can settle.

## Consequences

- A refusal pays one extra generation; an answer pays one more only when rescued.
- A reread that fails ships the first refusal and fails nothing, its estimated
  spend still on the trace.
- Both readings land on the trace, so a refusal shows the reading that declined
  and the reading that confirmed it; a refusal the reread contradicts faces the
  same reviewer and citation gate as any other answer.
