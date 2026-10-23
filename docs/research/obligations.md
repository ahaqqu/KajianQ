# An explicit evidence-obligation plan vs today's sub-query fan-out (#376)

Status: research in progress — brief committed before the first experiment; the
experiment log, tables and decision brief are appended as each experiment ends.

Refs #376

## Brief (committed before E1)

### The claim under test

> **C1 — the planner pays for itself.** A schema-validated obligation plan
> (kinds: `definition`, `comparison`, `ruling`, `dalil`, `scope`) followed by
> deterministic per-obligation retrieval, obligation-by-obligation synthesis,
> and per-obligation evidence validation improves evidence coverage and citation
> grounding enough to justify its extra calls — at a measured cost per answer.

The two outcomes are measured separately because they can diverge:

- **evidence coverage** — the required address (where the question has one) is
  in the context the writer sees, and each planned obligation has a passage that
  states what it requires;
- **citation grounding** — every citation in the answer resolves to a label in
  that context, and the required address is among the cited labels.

### Kill conditions

- **C1 dies** if the plan arm's coverage and grounding are not better than the
  fan-out arm's on the matched questions, or if the improvement is entirely
  explained by the caller's verbatim question being searched — i.e. arm **B2**
  (fan-out + the in-review caller-words rule) matches or beats arm **P**.
- **C1 dies at cost** if its per-answer cost is higher than the fan-out's while
  its coverage and grounding are not better, or if the extra cost per gained
  required address exceeds a threshold stated after E2 (the baseline cost).
- **The planner is not falsified by** a row whose required address is absent
  from the corpus, a row that needs a retrieval instrument other than a planner
  (`gs-v0-007`'s verse at exact rank 5352; `gs-v0-016`'s address at rank 48), or
  a row where the evidence is present and the generator still refuses.

### The decision it unblocks

Whether to spend engineering effort on a plan stage at all, and if yes, on which
question class: adopt, reject, or adopt-only-for `<class>`. The brief names the
production decisions an implementation would face: plan schema, obligation cap,
refusal semantics for an unsatisfied obligation, and the trace shape.

### What evidence settles it

A measured comparison on six questions between three arms — today's shape (B),
today's shape with the caller's words always searched (B2, a confound control
prototyping the in-review fix), and the obligation plan (P) — over the same
corpus, embedder, both embedding tracks, RRF, decision-model rerank, generator
prompt, and price table. Coverage is measured deterministically against declared
required addresses; obligation satisfaction and answer coverage are read by one
evidence judge applied identically to all three arms.

### Budget and stop rules

≤ $0.50 paid spend; one session; the harness aborts before crossing $0.45.
Stop at six experiments unless a result is ambiguous — an ambiguous result is
logged as such and resolved by the cheapest separating measurement, not by more
runs of the same arm.

### Deliverable

This file: brief, experiment log with stable `E<n>` ids, measurement tables,
spend, and the decision brief. The prototype lives in
[`research/obligations/`](../../research/obligations/): `kq.py` (shared
harness), `arms.py` (B / B2 / P), `plan.py` (planner, executor, writer,
validator), `run.py` (experiment driver), `selfcheck.py` (E0), `questions.py`,
and `prompts.generated.json` (production prompt text dumped from the domain
pack's own code, not hand-copied).

## What this prototype is, and what it is not

It is an offline, read-only reproduction of the serving shape — the router
prompt and its reply reading, the real `decomposeQuery` invoked through a Bun
bridge, the two embedding tracks, RRF(k=60) with the hierarchy bonuses, the
decision-model rerank over the whole fused block, the assembler's presentation
order and chunk rendering, and the production generator system prompt.

It is **not** the deployed pipeline. The differences, named here before any
number is reported:

- **No reviewer / reviewer pre-gate.** Production spends one reviewer call per
  answer, and its verdict can refuse an answer; both arms here measure the
  draft, and the reviewer's cost is excluded from both cost-per-answer figures.
- **No scope expansion, citation-label lookup, or neighbour expansion**
  (ADR-0045, ADR-0049). None of the six questions names a surah or a citation,
  and every required address is a hadith, so those stages cannot add the
  required row; they can still add context in production, which raises its cost
  and can change the generator's citations.
- **No router filters.** `grade` / `madzhab` / `textLayer` hints are ignored in
  both arms. A filter can only remove candidates, so ignoring it can only
  favour the fan-out arm.
- **Exact search, not ANN.** `ORDER BY distance, id` over the local corpus, with
  a stable id tie-break; production runs HNSW with no second sort key. The
  embedding space is validated in E0 against ranks a prior researcher measured.
- **No generator sampling pin.** Production does not pin it either (#376's
  remediation list names pinning it); the harness draws three answers per
  question-arm on the same evidence to expose that variance rather than hide it.
- **Local corpus at `127.0.0.1:55432`, read-only.** No production database, no
  deployed system, no trace written.
