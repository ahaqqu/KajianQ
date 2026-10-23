# An explicit evidence-obligation plan vs today's sub-query fan-out (#376)

Status: **complete** — decision brief below; paid spend **$0.491399 of $0.50**;
one branch, one session, no production change. Refs #376

## Brief (pre-registered before the first experiment)

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

### Amendments made after the first results (disclosed)

The brief is the pre-registration and is not rewritten. Three deviations
happened after results were in; each is disclosed here, and every table reports
the pre-registered definition as well as the amended one where they differ.

- **A1 — draws and B2 coverage were cut by the budget.** The design called for
  three generator draws per arm on all six questions. The first E3 run stopped
  on the internal guard at $0.406718 with 10 of 18 planned rows. The resumed run
  used three draws on the first three questions, one draw on `gs-v0-016`,
  `gs-v0-006` and `q-ruling`, and ran B2 on four questions only (`q-owner`,
  `q-tri`, `gs-v0-022`, `q-ruling`). Sixteen arm-rows were measured instead of
  eighteen; the one-draw arm-rows (six, across three questions) are labelled by
  their draw column in every table.
- **A2 — the internal stop guard was raised for the last arm.** The pre-registered
  guard was $0.45, with a $0.50 hard cap. After the resume the run stopped again
  at $0.481898 with `q-ruling P` unmeasured. I judged the sixth question more
  valuable than the unspent margin, lowered the per-call reserve from $0.025 to
  $0.008, and ran that one arm, landing at $0.491399. The hard cap was never
  crossed; the internal guard was. This is a deliberate, disclosed deviation,
  not an accounting accident.
- **A3 — the required address was widened to an identity class after E3.** The
  first requirement for `q-owner`/`q-tri` was the literal pair `HR. Bukhari no.
  4777` / `HR. Muslim no. 97`. Arm B's answers cited `HR. Bukhari no. 50`,
  `HR. Nasai no. 4990` and `HR. Muslim no. 99` — different chains of the same
  Jibril narration. I had written a requirement stricter than the evidence
  question, so the analysis now computes both the **exact** address and the
  **identity** class (E5). No arm was re-run: both states are recomputed from
  the stored context labels and citations. The exact state is reported
  everywhere, so the reader can ignore the amendment.

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
  The prototype's _validator_ is a different thing: a DeepSeek reader that marks
  each planned obligation supported/unsupported. It is the plan's proposed
  stage, not production's reviewer, and it is not ground truth (its readings are
  cross-checked by controls S11, not by a human).
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
  remediation list names pinning it); the harness draws up to three answers per
  question-arm on the same evidence to expose that variance rather than hide it
  (A1 applies to three of the six questions).
- **Local corpus at `127.0.0.1:55432`, read-only.** No production database, no
  deployed system, no trace written.
- **The identity classes are a research instrument, not gate data.** One comes
  from the owner-signed `hadith-identities-v0` fixture; two are researcher
  declarations backed by a reproducible corpus query
  ([`identity-classes.json`](../../research/obligations/identity-classes.json)).
  Extending the signed fixture is a curation decision (D6), not something this
  branch may do.

## Experiment log

Each entry is one command; the result JSONs and the call ledger are committed
beside the scripts, so every number below is re-derivable.

### E0 — can the harness reproduce ranks and behaviours someone else measured?

- **Setup:** `selfcheck.py`, 15 assertions across S1–S11, on the local corpus;
  embeddings and two evidence-judge controls are its only paid calls.
- **Command:** `python3 research/obligations/selfcheck.py`
- **Result:** 15/15 PASS.
  - S1 corpus: 42,511 rows, 42,511 primary and 37,014 fallback embeddings.
  - S2: `QS. 42:11` exact dense rank **5352** — reproduces the prior
    researcher's number, so the embedding space and scan semantics match.
  - S3: the `gs-v0-011` verbatim question puts `HR. Muslim no. 534` at primary
    rank **8** — the prior researcher's measured rank.
  - S4: the `gs-v0-007` fan-out cannot reach `QS. 42:11`, as reported.
  - S5: the verbatim `gs-v0-004` question puts `HR. Ibn Majah no. 224` at primary
    rank 2 and rerank #1. A replay during analysis (no paid call) added what the
    selfcheck does not assert: the fan-out for that question assembles 224 at
    position 1, and the paraphrase "keutamaan mencari ilmu" puts it at primary
    rank 10 — inside the ten-per-track pool. Artifact:
    [`gs-v0-004-replay.json`](../../research/obligations/gs-v0-004-replay.json).
  - S6: the real `decomposeQuery` bridge drops the caller's words; the
    caller-words variant restores them.
  - S7: a hand-computed RRF case reproduces at 0.042622950820.
  - S8: the citation scan finds four labels; a fabricated address is ungrounded
    and a covered range is grounded.
  - S9: seven planner-repair cases are deterministic and exact.
  - S10: a validator reply missing an obligation defaults it to unsupported.
  - S11: the evidence judge separates a gold passage from an unrelated one
    (positive and negative control).
- **Verdict:** the harness is trusted for the comparisons that follow. It was
  wrong twice before this run — S3/S4 first compared a fused position to a
  primary dense rank, and S8's regex missed lowercase `qs.` labels — and both
  bugs were fixed and re-proved, not written up as findings.
- **Cost:** included in the total (E0's calls are in the ledger).

### E1 — what does the planner emit, and does it need repair?

- **Setup:** `plan(question)` with the prototype planner prompt (strict JSON,
  kinds `definition|comparison|ruling|dalil|scope`, max 5), deterministic
  salvage for fenced/bare JSON and bad items.
- **Command:** `python3 research/obligations/run.py e1`
- **Result:** all six plans parsed with `repair: []`; 4–5 obligations each; the
  planner follows the caller's language (the English question gets English
  obligations); three of six plans hit the cap of five.
- **Verdict:** the schema and repair path work, but four obligation-quality
  failures are visible in the plans and they matter later:
  - `gs-v0-022` O1 ("hukum mendahulukan ibu daripada istri") and O5
    ("kewajiban menunaikan hak istri dan hak ibu secara bersamaan") **presuppose
    the ruling the question asks for**. They pulled generic Quran verses
    (`QS. 80:36`, `QS. 58:2`); the judge marked O3–O5 unsupported, and O1
    supported only in the generous reading that 5971 prioritises the mother —
    over the father, not over the wife.
  - `gs-v0-006` O4 asks the difference between jamak taqdim and jamak takhir —
    a distinction the caller did not ask about (scope creep).
  - `gs-v0-016` O1 narrows "the obligations of Zakat" to "zakat among the
    pillars of Islam", which steers retrieval to the five-pillars hadith and
    away from the zakat-on-wealth hadith the requirement names.
  - The fifth obligation's admitted evidence was redundant with the earlier
    ones or unused by the answer in every plan (see D3).
- **Cost:** $0.001324 total, 177–269 µUSD per question.

### E2 — does the fan-out's own retrieval carry the required address?

- **Setup:** retrieval only — router → real `decomposeQuery` → both embedding
  tracks → RRF + bonuses → decision rerank — for arms B and B2, on all six
  questions; no generation. B2 adds the caller's verbatim question as an extra
  sub-query (the in-review fix, prototyped, not endorsed).
- **Command:** `python3 research/obligations/run.py e2`
- **Result:** B and B2 both carry the required address for `q-owner`, `q-tri`,
  `gs-v0-022` and `gs-v0-006`; both miss `gs-v0-016` and both required addresses
  of `q-ruling`. B2 adds no coverage on any of the six and changes the candidate
  pool (30 vs 29 unique on `q-owner`, 53 vs 46 on `gs-v0-022`). The rerank failed
  open on `gs-v0-016` (`max_tokens_exceeded` from the decision endpoint), so that
  row's context is the fused order, not the reranked one.
- **Verdict:** on four of six questions the fan-out already reaches the required
  address before the planner exists — the "planner is needed to find the
  evidence" premise is false there. `gs-v0-016` and `q-ruling` are
  retrieval-instrument misses (consistent with #376's own triage), not planning
  failures; the planner cannot be credited or blamed for them except through
  its pool, which E3 checks.
- **Cost:** included in the total.

### E3 — does the plan arm beat the fan-out on coverage, grounding and cost?

- **Setup:** 16 arm-rows — B on six questions, B2 on four, P on six (A1) — with
  the same corpus, embedder, fuse, rerank, generator prompt and price table.
  The same E1 obligations are used to judge all arms' contexts; the judge reads
  the first answer of each arm. P's validator is part of its proposed path and
  is counted in its cost; the judge on B/B2 is measurement-only and excluded.
  `q-ruling P` was completed after A2.
- **Command:** `python3 research/obligations/run.py e3`
- **Result:** tables below. Headline: exact-address context coverage **B 4/6,
  P 3/6**; identity coverage **B 4/6, P 4/6**; obligations supported **B 22/27,
  P 20/27**; every citation grounded in every arm (216 citations, 0 ungrounded);
  refusals **B 2/14, P 0/12**; mean cost **B 11,061 µUSD, P 11,787 µUSD per
  answer (+6.6%)** with **67% fewer prompt tokens**.
- **Verdict:** **C1 is refuted on evidence coverage and on citation grounding,
  and it loses at cost.** The plan's small context does not produce better
  coverage; the fan-out's broad context is slightly better on the judge's
  reading. The only behavioural gain is the absence of over-refusals on
  `gs-v0-022`, and that row's comparison is not supported by the cited hadith
  (D2). The budget stop is recorded in A1/A2; E4 was descoped.
- **Cost:** see the spend table.

### E4 — admission-cap sensitivity (K = 5) — not run

- **Reason:** A2 left $0.0086 of the hard cap; an E4 run on two questions
  (writer + validator) was estimated at ~$0.012–0.015 and would have crossed it.
  Descoped by the pre-registered stop rule.
- **Consequence:** the diagnostic in E3 shows that P's exact miss on
  `gs-v0-006` (`HR. Bukhari no. 1108` sits in every obligation's fused pool at
  ranks 19–34, reranked 6–21, never admitted under K=3) is an **admission-cap**
  effect, and `gs-v0-016`'s 1395 sits in O1's fused pool at 25 (reranked 19).
  Whether K=5 recovers them is unmeasured. This is the first follow-up (D4).

### E5 — how much of the miss is the requirement, not the evidence?

- **Setup:** no paid calls. Recompute every requirement state from the stored
  context labels and citations under two definitions: the **exact** declared
  address, and the **identity** class — the owner-signed
  `hadith-identities-v0` group for `gs-v0-006`, a corpus query
  (`text_id ILIKE '%jibril%' AND text_id ILIKE '%ihsan%'`) for the Jibril
  narration, and a corpus query (`text_id ILIKE '%ibumu%' AND text_id ILIKE
  '%ayahmu%'`) for the mother/father narration. `gs-v0-016` and `q-ruling` have
  no class and stay exact.
- **Command:** `python3 research/obligations/analysis.py`
- **Result:**
  - `q-owner`: exact cited **B 0/3, B2 2/3, P 3/3**; identity cited **3/3 in
    all three arms**. B's "miss" is a parallel chain of the same narration, not
    missing evidence.
  - `q-tri`: exact **B 2/3, B2 1/3, P 2/3**; identity **3/3 everywhere**.
  - `gs-v0-022`: identity = exact (only 5971 is retrieved); B 1/3, B2 2/3, P 3/3.
  - `gs-v0-006`: exact **B 1/1, P 0/1**; identity **B 1/1, P 1/1** — P admits
    `HR. Muslim no. 1624`, a signed member of the 1108 group.
  - `gs-v0-016`: no class, **0/3 B, 0/1 P**. Both arms answer with the
    five-pillars narration (`HR. Bukhari no. 8` is cited by both); the required
    1395 is absent.
  - `q-ruling`: no class, **0/1 in all arms**; B and B2 cite `HR. Bukhari no.
    1504` / `HR. Muslim no. 2282` (siblings of 1503) and `QS. 9:103` / `QS. 9:60`
    for the wealth part; P cites 1504/1509 but no Quran.
- **Verdict:** exact-address scoring overstates **both** sides' deficits. It
  makes B look worse on `q-owner` than the evidence warrants and P look worse on
  `gs-v0-006` than its (identity-valid) citation warrants. Under identity
  scoring the arms tie at 4/6 questions cited. The genuine shared miss is
  `gs-v0-016` (and the exact 1395/1503 labels), where no arm finds the named
  hadith. The wider lesson is a curation finding, not a planner finding (D6).
- **Cost:** none.

### E6 — is the cost reconstruction faithful?

- **Setup:** no paid calls. Replay each arm's retrieval from the cache — cached
  embeddings, read-only SQL, cached decision distributions — rebuild the
  admitted chunk set, and fail loudly if it differs from the recorded context;
  then price every stage from the vendor's own token counts and the repo price
  table.
- **Command:** `python3 research/obligations/analysis.py`
- **Result:** **16/16 replays matched** the recorded context label sets. The
  per-stage prices sum to the ledger's $0.491399. Fail-opens are priced at zero
  (the vendor returned no usage). Retrieval and plan calls are 7–11% of a
  B/B2 answer and 15–26% of a P answer before validation; P's validator adds
  24–34%. Generation dominates B/B2, and the validator plus per-obligation
  reranks dominate P's overhead.
- **Verdict:** the cost table is a reconstruction of the measured retrieval, not
  an estimate on a different one. It still excludes infra/serving and the
  reviewer (both arms), and it uses list price at the committed table.

## Measurement tables

### Evidence and citation

`Required in context` is the deterministic check; `required cited` counts draws
whose answer cites a member of the required group. `Obligations supported` is the
judge's reading of the first answer's context. `Grounding` is the share of cited
labels that appear in the context the writer saw (the citation gate's check, not
a claim-level attribution check). A refusal draw cites nothing and is excluded
from the grounding mean, which is why an arm with refusals can still read 1.00.
The one-draw arm-rows are marked by their draw column.

<!-- TABLES-EVIDENCE -->

| Question  | Arm | Draws | Ctx chunks | Obligations supported | Required in context — exact / identity | Required cited — exact / identity | Citations per answer | Grounding | Refusals |
| --------- | --- | ----: | ---------: | --------------------- | -------------------------------------- | --------------------------------- | -------------------- | --------- | -------- |
| q-owner   | B   |     3 |         29 | 4/4                   | yes / yes                              | 0/3 / 3/3                         | 2–3                  | 1.00      | 0/3      |
| q-owner   | B2  |     3 |         30 | 4/4                   | yes / yes                              | 2/3 / 3/3                         | 2–11                 | 1.00      | 0/3      |
| q-owner   | P   |     3 |          6 | 3/4                   | yes / yes                              | 3/3 / 3/3                         | 3–5                  | 1.00      | 0/3      |
| q-tri     | B   |     3 |         11 | 4/5                   | yes / yes                              | 2/3 / 3/3                         | 2–11                 | 1.00      | 0/3      |
| q-tri     | B2  |     3 |         14 | 4/5                   | yes / yes                              | 1/3 / 3/3                         | 4–9                  | 1.00      | 0/3      |
| q-tri     | P   |     3 |          8 | 4/5                   | yes / yes                              | 2/3 / 3/3                         | 4–5                  | 1.00      | 0/3      |
| gs-v0-022 | B   |     3 |         46 | 2/5                   | yes / yes                              | 1/3 / 1/3                         | 0–7                  | 1.00      | 2/3      |
| gs-v0-022 | B2  |     3 |         53 | 2/5                   | yes / yes                              | 2/3 / 2/3                         | 0–5                  | 1.00      | 1/3      |
| gs-v0-022 | P   |     3 |         10 | 2/5                   | yes / yes                              | 3/3 / 3/3                         | 8–10                 | 1.00      | 0/3      |
| gs-v0-016 | B   |     3 |         24 | 3/4                   | **no** / **no**                        | 0/3 / 0/3                         | 4–9                  | 1.00      | 0/3      |
| gs-v0-016 | P   |     1 |          9 | 4/4                   | **no** / **no**                        | 0/1 / 0/1                         | 9–9                  | 1.00      | 0/1      |
| gs-v0-006 | B   |     1 |         42 | 4/4                   | yes / yes                              | 1/1 / 1/1                         | 6–6                  | 1.00      | 0/1      |
| gs-v0-006 | P   |     1 |          5 | 3/4                   | **no** / yes                           | 0/1 / 1/1                         | 5–5                  | 1.00      | 0/1      |
| q-ruling  | B   |     1 |         35 | 5/5                   | **no** / **no**                        | 0/1 / 0/1                         | 15–15                | 1.00      | 0/1      |
| q-ruling  | B2  |     1 |         37 | 5/5                   | **no** / **no**                        | 0/1 / 0/1                         | 13–13                | 1.00      | 0/1      |
| q-ruling  | P   |     1 |         11 | 4/5                   | **no** / **no**                        | 0/1 / 0/1                         | 11–11                | 1.00      | 0/1      |

<!-- /TABLES-EVIDENCE -->

### Cost and tokens

Per answer: the first draw's retrieval and plan calls plus the mean generation
cost of that arm's draws (which includes refusal draws and re-reads). The
validator is counted for P only; the judge on B/B2 is measurement overhead.
Totals are list price at `models.json`.

<!-- TABLES-COST -->

| Question  | Arm | Prompt tok | Completion tok | Generation µUSD | Retrieval + plan µUSD | Validator µUSD | Total µUSD/answer |
| --------- | --- | ---------: | -------------: | --------------: | --------------------: | -------------: | ----------------: |
| q-owner   | B   |     29,606 |            638 |           9,647 |                 1,138 |              0 |        **10,785** |
| q-owner   | B2  |     29,757 |            642 |           9,698 |                 1,160 |              0 |        **10,858** |
| q-owner   | P   |     11,367 |          1,442 |           5,140 |                 2,952 |          3,983 |        **12,076** |
| q-tri     | B   |     23,535 |            895 |           8,135 |                 1,159 |              0 |         **9,293** |
| q-tri     | B2  |     25,081 |            823 |           8,511 |                 1,085 |              0 |         **9,596** |
| q-tri     | P   |     16,157 |          1,566 |           6,726 |                 4,336 |          5,632 |        **16,694** |
| gs-v0-022 | B   |     45,612 |            895 |          14,757 |                 1,036 |              0 |        **15,793** |
| gs-v0-022 | B2  |     32,069 |            751 |          10,522 |                 1,098 |              0 |        **11,620** |
| gs-v0-022 | P   |      5,021 |          2,922 |           5,012 |                 1,786 |          2,843 |         **9,641** |
| gs-v0-016 | B   |     20,008 |          2,070 |           8,487 |                   923 |              0 |         **9,409** |
| gs-v0-016 | P   |     12,244 |          3,025 |           7,303 |                 2,687 |          4,750 |        **14,741** |
| gs-v0-006 | B   |     21,823 |          1,416 |           8,246 |                 1,030 |              0 |         **9,275** |
| gs-v0-006 | P   |      2,601 |            628 |           1,534 |                 1,865 |          1,069 |         **4,468** |
| q-ruling  | B   |     25,145 |          2,343 |          10,355 |                 1,457 |              0 |        **11,812** |
| q-ruling  | B2  |     26,178 |          1,353 |           9,477 |                 1,493 |              0 |        **10,970** |
| q-ruling  | P   |      7,797 |          3,036 |           5,982 |                 3,602 |          3,519 |        **13,103** |

<!-- /TABLES-COST -->

### Arm aggregates

<!-- TABLES-AGGREGATE -->

| Arm | Questions | Draws | Obligations supported | Required in context (exact / identity) | At least one draw cites the required address (exact / identity) | Refusals | Ungrounded citations | Prompt tok / answer | Completion tok / answer | µUSD / answer |
| --- | --------: | ----: | --------------------- | -------------------------------------- | --------------------------------------------------------------- | -------: | -------------------: | ------------------: | ----------------------: | ------------: |
| B   |         6 |    14 | 22/27                 | 4/6 / 4/6                              | 3/6 / 4/6                                                       |     2/14 |                    0 |              27,622 |                   1,376 |    **11,061** |
| B2  |         4 |    10 | 15/19                 | 3/4 / 3/4                              | 3/4 / 3/4                                                       |     1/10 |                    0 |              28,271 |                     892 |    **10,761** |
| P   |         6 |    12 | 20/27                 | 3/6 / 4/6                              | 3/6 / 4/6                                                       |     0/12 |                    0 |               9,198 |                   2,103 |    **11,787** |

<!-- /TABLES-AGGREGATE -->

### The fan-out's own retrieval (E2)

`Required address in context` here is the exact declared group. The sub-queries
are the production router's own output after the real deterministic
decomposition.

<!-- TABLES-BASELINE -->

| Question  | B: required address in context | B2: required address in context | Fan-out sub-queries (B)                                                                                                                                                                                                         |
| --------- | ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| q-owner   | yes                            | yes                             | `perbedaan iman dan ihsan dalam Islam`<br>`definisi ihsan hadits Jibril arkan al-din`<br>`makna iman tasdiq amal dan tingkatan ihsan`                                                                                           |
| q-tri     | yes                            | yes                             | `perbedaan iman islam ihsan hadis Jibril`<br>`hadis Jibril arkan al-iman al-islam al-ihsan`<br>`definisi islam iman ihsan menurut ulama akidah`                                                                                 |
| gs-v0-022 | yes                            | yes                             | `prioritas berbakti kepada ibu dibanding istri dalam Islam birrul walidain`<br>`hak istri dan kewajiban suami nafkah serta mu'asyarah bil ma'ruf`<br>`kaidah rahmah dan masyaqqah dalam menyeimbangkan bakti ibu dan hak istri` |
| gs-v0-016 | **no**                         | **no**                          | `hadith zakat obligations pillars of Islam`<br>`حديث بني الإسلام على خمس وإيتاء الزكاة`<br>`sanad hadith Ibn Umar Islam built on five zakat`                                                                                      |
| gs-v0-006 | yes                            | yes                             | `hukum jamak shalat dalam safar menurut empat madzhab`<br>`prinsip yusr dan raf'ul haraj dalam rukhshah safar`<br>`dalil Al-Quran dan hadis tentang jamak shalat saat safar`                                                    |
| q-ruling  | **no**                         | **no**                          | `hukum zakat fitrah dan zakat mal serta syarat wajib muzakki`<br>`dalil kewajiban zakat fitrah dan zakat mal dalam Al-Qur'an dan hadis`<br>`prinsip yusr dan rahmah dalam kewajiban zakat harta`                                |

<!-- /TABLES-BASELINE -->

### The plans (E1)

<!-- TABLES-PLANS -->

| Question  | Obligations (kind: text)                                                                                                                                                                                                                                                                                                                                                                                                                                   | Repair | Planner µUSD |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -----------: |
| q-owner   | `O1` definition: definisi iman dalam Islam<br>`O2` definition: definisi ihsan dalam Islam<br>`O3` comparison: perbedaan antara iman dan ihsan<br>`O4` dalil: hadis Jibril tentang iman, islam, dan ihsan                                                                                                                                                                                                                                                   | none   |          177 |
| q-tri     | `O1` definition: definisi iman dalam Islam menurut Al-Qur'an dan hadis<br>`O2` definition: definisi islam sebagai agama dan amal lahiriah<br>`O3` definition: definisi ihsan dalam hadis Jibril<br>`O4` dalil: hadis Jibril tentang islam, iman, dan ihsan<br>`O5` comparison: perbedaan antara iman, islam, dan ihsan menurut ulama                                                                                                                       | none   |          227 |
| gs-v0-022 | `O1` ruling: hukum mendahulukan ibu daripada istri dalam berbakti<br>`O2` dalil: hadis tentang siapa yang paling berhak mendapat bakti seorang anak (ibu, lalu ibu, lalu ibu, lalu ayah)<br>`O3` comparison: perbandingan hak ibu dan hak istri atas seorang lelaki<br>`O4` scope: kapan mendahulukan istri diperbolehkan dan kapan ibu didahulukan<br>`O5` ruling: kewajiban menunaikan hak istri dan hak ibu secara bersamaan tanpa menzalimi salah satu | none   |          269 |
| gs-v0-016 | `O1` dalil: hadith that mentions the obligation of zakat among the pillars of Islam<br>`O2` ruling: ruling on zakat being obligatory (wajib) and one of the five pillars<br>`O3` scope: conditions and categories of wealth and people to whom zakat applies<br>`O4` definition: meaning of zakat in Islamic law                                                                                                                                           | none   |          197 |
| gs-v0-006 | `O1` ruling: hukum menjamak shalat bagi musafir<br>`O2` dalil: dalil hadis tentang menjamak shalat saat safar<br>`O3` scope: syarat dan ketentuan menjamak shalat dalam safar<br>`O4` comparison: perbedaan jamak taqdim dan jamak takhir                                                                                                                                                                                                                  | none   |          200 |
| q-ruling  | `O1` ruling: hukum zakat fitrah wajib bagi setiap muslim<br>`O2` ruling: hukum zakat mal wajib bagi yang memenuhi syarat nisab dan haul<br>`O3` scope: siapa yang wajib mengeluarkan zakat fitrah dan syaratnya<br>`O4` scope: siapa yang wajib mengeluarkan zakat mal dan syarat nisab haul<br>`O5` dalil: dalil Al-Quran dan hadis tentang kewajiban zakat fitrah dan zakat mal                                                                          | none   |          253 |

<!-- /TABLES-PLANS -->

### Spend

162 paid calls, 1,921,158 prompt tokens, 72,854 completion tokens, **$0.491399**
— 98.3% of the $0.50 cap. Wall-clock over the call ledger: 21 minutes from the
first call to the last (session wall-clock was longer; the paid work is what the
ledger times). The ledger also contains E0/E2 calls, every generator draw and
the stopped run's duplicate judge call, so its stage totals are higher than the
sum of the one-answer-per-arm reconstruction in the cost table.

<!-- TABLES-SPEND -->

| Stage                                        |        µUSD |
| -------------------------------------------- | ----------: |
| generator, arm B                             |     147,236 |
| generator, arm B2                            |     113,323 |
| generator, arm B (refusal re-read)           |      23,710 |
| generator, arm B2 (refusal re-read)          |       7,228 |
| writer, arm P                                |      65,455 |
| decision rerank                              |      26,096 |
| router                                       |       2,648 |
| planner                                      |       1,324 |
| embeddings                                   |         163 |
| validator, arm P (proposed stage)            |      21,796 |
| evidence judge, arms B/B2 (measurement only) |      82,157 |
| duplicate judge call from the stopped run    |         263 |
| **Total**                                    | **491,399** |

<!-- /TABLES-SPEND -->

For context, #376 reports ~6.5 µUSD per row for the 21-row production eval
($0.135750 at the committed prices). That figure is **not comparable** to the
per-answer numbers here: different question mix (Quran-heavy short chunks vs
these long hadith matns), no reviewer in either arm here, no embedding of a
production-sized query set, and the run's own stage binding. It is quoted only
so the reader does not mistake 11 µUSD/answer for production's current cost.

## Reported versus measured

The research method requires the two streams to be labelled. The reported
observations, and what the local measurement says about each:

- **`q-owner` — reported:** the fan-out answered citing `HR. Bukhari no. 4777`
  and `HR. Muslim no. 97`. **Measured:** arm B never cited either in three
  draws; it cited `HR. Bukhari no. 50`, `HR. Nasai no. 4990` and `HR. Muslim no.
  99`, which are the same Jibril narration in other collections. The reported
  labels did not reproduce; the reported _content_ did. This is what forced A3.
- **`gs-v0-004` — reported:** paraphrase displacement means the required hadith
  is never retrieved. **Measured (E0 S5):** the verbatim question puts `HR. Ibn
  Majah no. 224` at primary rank 2 and rerank #1, and the local fan-out
  assembled it at position 1; the paraphrase "keutamaan mencari ilmu" puts 224
  at primary rank 10, inside the ten-per-track pool
  ([`gs-v0-004-replay.json`](../../research/obligations/gs-v0-004-replay.json)).
  The _mechanism_ (the caller's words are not searched by `decomposeQuery`)
  reproduced; its consequence on this row did not. Do not cite `gs-v0-004` as a
  reproduced red, and do not cite it as evidence for a planner.
- **`gs-v0-022` — reported:** the replacement row passes, citing 5971.
  **Measured:** arm B cited 5971 in **1 of 3** draws; the other two were literal
  refusals ("tidak menemukan dalil yang memadai", 20 completion tokens) with
  5971 in the context. A single deployed pass is consistent with a lucky draw,
  and the local baseline over-refuses on this row.
- **`gs-v0-006` — reported:** the evidence was present and the answer cited
  three parallel narrations. **Measured:** arm B retrieved and cited 1108 and
  1624; arm P admitted and cited 1624 (a signed identity member) but not 1108.
  The exact address is a miss for P, the identity is not.
- **`gs-v0-016` — reported:** the required address sits at primary rank 48 and
  is not assembled. **Measured:** absent from every B and P context; reproduced.
  The plan's O1 query put 1395 into its fused pool at rank 25, but the rerank
  placed it 19th and K=3 admitted none of it. The planner narrows 48 → 25; it
  does not close the gap.

## Decision brief

### D1 — Adopt the obligation planner as a general retrieval/synthesis stage? **No — reject.**

- **Evidence:** E2 (the fan-out already reaches the required address on 4/6
  before any planner), E3 (exact context B 4/6 vs P 3/6; identity 4/6 vs 4/6;
  obligations 22/27 vs 20/27; grounding 1.00 in both; cost +6.6%; refusals the
  only P win), E5 (the one exact gain, `q-owner`, disappears under identity
  scoring).
- **Why it matters:** a plan stage is a contract, a trace shape and a new failure
  surface. On this evidence it buys no coverage and no grounding, and it costs
  slightly more per answer despite using two-thirds fewer prompt tokens; the
  extra money goes to per-obligation reranks and the validator.
- **Default if nobody rules:** no plan stage is built. #376's remaining reds
  stay with the existing instruments; the follow-ups below are separate
  decisions.
- **What would change the answer:** a question class where coverage or
  grounding improves reproducibly under identity-aware scoring, or the same
  coverage at a lower total cost after removing the validator — neither is in
  this data.

### D2 — Adopt it only for comparison questions where the fan-out over-refuses? **No class survives.**

- **Evidence:** E3 — `gs-v0-022` is the only row with a P win: required cited
  3/3 vs B 1/3 (B2 2/3), cost 9,641 vs 15,793 µUSD, and B refused 2/3 draws with
  the hadith in context. But the judge marks the comparison obligation
  unsupported in **all three arms**: 5971 ranks the mother above the father, not
  above the wife. P answers a question the evidence does not settle, citing a
  hadith that does not state the comparison; B's refusal is defensible on the
  same evidence. `q-owner`/`q-tri` show no gain once identity is scored.
- **Why it matters:** shipping the plan "for comparisons" would make the product
  more confident exactly where it should hedge. The metric (does the answer cite
  the required address) and the product question (is the answer warranted) point
  in opposite directions here.
- **Default if nobody rules:** no class-scoped adoption.
- **What would change the answer:** a pre-registered comparison-only experiment
  with at least five questions and a refusal-quality rubric that distinguishes
  "refuses with the evidence present" from "correctly declines an unsettled
  comparison".

### D3 — If a plan stage is ever revived: plan schema and obligation cap. **Hold; cap 3, neutral evidence needs only.**

- **Evidence:** E1 (presuppositional obligations on `gs-v0-022`, scope creep on
  `gs-v0-006`, interpretation narrowing on `gs-v0-016`), E3 (the 4th/5th
  obligations' admitted evidence was redundant or unused; obligations supported
  is 20/27 for P, and the judge's unsupported marks cluster on the comparison /
  scope obligations).
- **Why it matters:** an obligation is an instruction to find evidence for a
  proposition. A proposition the caller did not ask and the corpus does not
  state manufactures an answer; a cap of five invites exactly that. Three
  neutral evidence needs are the most this evidence supports, and the ADR must
  forbid obligation text that embeds a yes/no ruling.
- **Default if nobody rules:** no plan stage; if one ships anyway, cap 3 and
  reject presuppositional obligation text in the schema validator.
- **What would change the answer:** an obligation-count sweep (3 vs 5) showing
  unique admitted evidence per obligation and no unsupported marks, plus E4's
  admission-cap result.

### D4 — Admission cap and rerank candidate limit. **Hold; K=3 is not a safe default, and fail-open must be visible.**

- **Evidence:** E3 diagnostics — `gs-v0-006`'s 1108 is in every obligation's
  fused pool (ranks 19–34) but the reranker places it 6–21, so K=3 admits 1624
  instead; `gs-v0-016`'s 1395 is in O1's pool at 25 and reranked 19. The
  decision endpoint returned `max_tokens_exceeded` on both E2 requests for
  `gs-v0-016` and on 1 of E3's 27 plan reranks; each time the harness kept the
  fused order and recorded no cost.
- **Why it matters:** on this evidence the exact-address outcome is decided by
  the reranker and K, not by the plan text. A production ADR must name K, whether
  the reranker sees the whole fused block, and whether a failed rerank may fall
  back to fused order invisibly. In this harness it does, and the record does not
  mark it; production's trace behaviour was not inspected.
- **Default if nobody rules:** serving keeps today's behaviour; no cap change on
  this evidence.
- **What would change the answer:** E4 at K=3/5/8 measuring exact and identity
  coverage and per-answer cost, plus a fail-open visibility decision.

### D5 — Refusal semantics when an obligation is unsatisfied. **Hold; marks to the trace, one plain hedge in the answer, no ids in user text.**

- **Evidence:** E3 — the writer leaked `O1`/`E1` ids into **all 12** plan
  answers ("**O1 [ruling] …**", "E2: …"); the judge marked three of five
  obligations unsupported on `gs-v0-022` (O3–O5) in every arm; B refused 2/3
  draws there while P answered confidently with an inference. On `gs-v0-016`
  both arms answered with the five-pillars hadith instead of the named zakat
  hadith, and neither hedged.
- **Why it matters:** a mark that says "unsupported" while the answer asserts
  the claim is worse than either a refusal or an honest hedge. The trace can
  carry the per-obligation reading without leaking plan vocabulary into the
  product.
- **Default if nobody rules:** if a validator ships, its readings are trace-only
  and the answer gets a single plain-language sentence when any obligation is
  unsupported; obligation/evidence ids never appear in user text.
- **What would change the answer:** an answer-format experiment measuring
  user-visible hedges, id leakage and refusal quality — not citation counts.

### D6 — Requirement precision: identity-aware required addresses in the eval. **Recommend yes for reporting; gate semantics stay with the owner.**

- **Evidence:** E5 — `q-owner` exact 0/3 vs identity 3/3 for B; `gs-v0-006` P
  exact 0/1 vs identity 1/1; `q-ruling`'s 1503 has sibling 1504 in both arms'
  answers; `gs-v0-016`'s 1395 has five-pillars siblings in both contexts. The
  signed fixture already encodes this for four narrations; the Jibril and
  mother/father classes here are researcher declarations with a reproducible
  corpus query.
- **Why it matters:** exact-address scoring rewards label-matching and hides
  that the evidence is present; it also moves the planner's apparent score
  depending on which valid chain the writer happens to cite. A gate that cannot
  tell a parallel narration from a fabricated one will keep producing reds that
  are curation work.
- **Default if nobody rules:** the gate keeps exact scoring (its current
  contract); the eval report adds identity coverage as a second column, and the
  two researcher-declared classes stay prototype-only until the owner signs an
  extended map.
- **What would change the answer:** an owner-signed identity map covering the
  flagged rows (`5971`, `1395`, `1503`, `4777`/`97`) and a decision on whether
  the gate accepts identity members.

### D7 — Trace shape, if a plan stage is ever built. **Hold; per-obligation events or it is undebuggable.**

- **Evidence:** E3's diagnostics (which required address sat in which
  obligation's pool, at which rank, and why it was not admitted) are exactly the
  records that make the 006/016 misses explainable. A trace that records the
  context but not the obligation-to-evidence mapping cannot answer "which
  obligation failed"; the prototype had to store per-obligation admission
  records and replay the cache to answer it.
- **Why it matters:** without obligation ids on retrieval, admission and
  validation, the operator sees a context, not a decision. The trace is the
  product boundary, not a debugging convenience.
- **Default if nobody rules:** no plan stage, so no new trace shape; if one
  ships, it must emit `plan`, `obligation.retrieval`, `obligation.admission` and
  `validator.reading` events with obligation and evidence ids, and mark a
  fail-open rerank explicitly.
- **What would change the answer:** nothing measured — this is a product
  boundary decision, and the prototype's requirements are stated above.

## What this prototype cannot speak to

- **The reviewer and its pre-gate.** Both arms are un-reviewed; production may
  refuse either arm's answer, and the reviewer's cost is absent from both sides.
  A plan stage's smaller context might make the reviewer cheaper — unmeasured.
- **The deployed pipeline's other stages** (scope expansion, label lookup,
  neighbour expansion) can add evidence and cost; none of the six questions
  names a citation or surah, so they cannot add the required _label_, but they
  change the context the writer sees.
- **ANN, filters, sampling, corpus snapshot and model drift.** The local corpus
  is exact-scanned and read-only at one snapshot; production runs HNSW and may
  hold a different corpus.
- **Golden Set coverage.** Six questions: two Golden Set rows (`gs-v0-016`,
  `gs-v0-006`), one row from the in-review branch (`gs-v0-022`), one owner
  question, one researcher comparison, one researcher multi-part ruling. The
  smoke subset contains none of them. This is not a Golden Set run and cannot
  clear one.
- **Statistics.** Three draws on three questions, one on three; B2 on four. The
  draws are not independent of the fixed evidence, and no significance test is
  meaningful at this n. The cost figures are exact list price, the coverage
  figures are deterministic, and the obligation readings are one judge's
  readings (with S11 controls, not human labelling).
- **The validator as a product judge.** It is a DeepSeek reader with a fixed
  instruction; its 2/5 on `gs-v0-022` is a signal of corpus ambiguity, not
  ground truth.
- **A production ADR's full surface.** D1–D7 name the decisions this evidence
  touches; they do not write the ADR, and the branch deliberately changes no
  production code, gate, spec or trace.

## Reproduction

```bash
# local corpus, read-only; keys from the repo-root .env
python3 research/obligations/selfcheck.py       # E0 — makes paid calls
python3 research/obligations/run.py e1          # E1 — planner
python3 research/obligations/run.py e2          # E2 — retrieval only
python3 research/obligations/run.py e3          # E3 — the arms
python3 research/obligations/analysis.py        # E5/E6 — no paid calls
python3 research/obligations/render_tables.py   # rewrite the tables in this file
```

The cache under `research/obligations/.cache/` is deliberately not committed
(it holds generated embeddings and LLM replies). The committed
`results-main.json`, `e1-plans.json`, `e2-baseline.json`, `analysis.json` and
`ledger.jsonl` are enough to re-derive every table without a paid call; a fresh
end-to-end run would cost about what this one did.
