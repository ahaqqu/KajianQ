# ADR-0055: A refusal is read twice before it ships

## Decision

A refusal is the generator's claim that the retrieved evidence cannot answer the
question. That claim is **shipped only when the generator reaches it twice**: a
pure refusal is reread, and the refusal is delivered only when the reread is a
pure refusal too. Only that shape is reread: a draft that answers — a hybrid
carrying the sentence included — never is; the stage reads the predicate its owner
defines.

The second reading is the same assembled evidence, except when the **verbatim
question names a citation address the assembled context carries**. There it is
**directed**: it names that evidence and rules the insufficiency sentence out for
that question, while keeping the honest decline the context's silence earns. The
trigger is deterministic — the citation grammar's scan of the verbatim question
joined to the chunks' stored metadata — so a question naming no address, or one
the context does not hold, keeps the plain reading.

The reread is the generator's own second reading, not a second refusal rule: the
deterministic classification, the citation gate, the reviewer and the trap
acceptance keep their single owner. A refusal ships only when both readings
decline, so the rule lowers a sampled refusal's rate — near p² — but never
eliminates it; an answer the reread produces is judged by the gate. A trap
accepts a grounded reread answer (ADR-0046), keeping that record's
grounded-but-dated residual reachable.

## Why

The generator is a sampled model, and a refusal is one sample of a judgment about
the evidence: the same context can read as sufficient and as insufficient. The
prompt already makes present evidence an answer (ADR-0015), so what is missing is
a reading that must reproduce before it ships.

When the question prints an address the context carries, the refusal is
contradicted by a fact the pipeline read rather than by a judgment: repeating the
same prompt tests the sample, not the claim, while the trap class names no address
and cannot reach the trigger.

Rejected: a first refusal treated as final (a coin flip on an answerable
question); a non-empty context treated as permission to answer (it ships answers
the evidence does not hold); another refusal clause in the prompt (the clause that
makes present evidence an answer is already there); a "context non-empty,
therefore answer" rule (it cannot separate addressing from topical evidence);
suppressing the refusal when addressed evidence is present (the model still writes
the answer and the citation gate still judges it).

## Consequences

- A refusal pays one extra generation; the directed reading replaces the plain
  one, so the count does not rise, and an unreadable reread leaves the first
  refusal standing with its estimated spend on the trace.
- A directed reread that declines too still ships the first refusal: the residual
  is a model that declines with the named evidence in hand, recorded, not papered
  over.
- Both readings land on the trace, the directed one under its own purpose, so a
  refusal shows the reading that declined and the one that confirmed or contradicted
  it; the reread's answer faces the same reviewer and citation gate as any other.
- A trap question, and a question naming an address the corpus does not carry,
  are untouched: no directive, and no new licence to answer.
