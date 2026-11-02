# Where KajianQ's answer quality actually leaks — and the cheapest experiment that can tell

**Status.** Research brief on branch `research/rag-eval`, at `92f95d0` (2026-10-31). Read-only:
no production code, no model or embedding purchase, no paid API call, no database write, no PR.
The only command run here beyond repository reads was the quote-fidelity unit suite
(`bunx vitest run packages/eval/src/quote-fidelity.test.ts`, 19 passed), which is a known-case
check of the scorer, not a new measurement of the product.

**How to read the evidence.** Every claim below is one of:

- **measured** — read from the fixture, the code, or a command run in this worktree;
- **reported** — a number or observation from an issue, PR, QA report, Actions log, or a research
  artifact; not re-run here;
- **unavailable** — the repository and its public history do not contain it.

The distinction matters: most of the useful numbers in this repository are **reported**, not
persisted in a form this session can recompute, because QA traces are erased after each run and
the eval ledger lives in Postgres, which this task does not read (repository and public evidence
only).

---

## 0. The claim, the kill condition, and the decision

**Claim under test.** _On the current build, the dominant cause of wrong or untrustworthy answers
is generator output discipline — specifically, words inside quotation marks that no cited
passage contains — rather than retrieval/ranking, citation/evidence handling, or missing corpus
data._

This is deliberately narrower than "the model is bad". It is falsifiable by a fresh full-set run
and a held-out probe:

- **Kill condition.** If any failed row's failing leg is `citationAddressRecall` or
  `sourceTypeRecall` (retrieval), or `citationValidity` on an answer whose evidence was retrieved
  (citation/evidence handling), the claim is false and the cause is one of those classes, not
  quote discipline.
- **Decision it unblocks.** Whether the next accuracy ticket buys an embedder, a reranker, a
  generator, a reviewer change, or grades — or spends nothing on models and fixes the output
  contract and the measurement first.
- **What would settle it.** A full 21-row run at the current head, repeated enough times to tell a
  draw from a defect, with per-row leg attribution and the report-only quote-fidelity number; plus
  the small held-out probe that the repository does not yet carry on `main`.

**Verdict in three sentences.** The historical dominant cause of wrong answers was
retrieval/ranking, and the fixes that landed between 22 and 27 October moved the _manual_ full
suite from 15/21 to 21/21 on three consecutive draws. But the _automated_ deploy gate samples 5 of
21 rows, holds out the four required-hadith-address rows, and does not gate address recall, so the
current build's automated green does not test the class that used to fail; the current head's full
suite is unmeasured after the per-chain prompt change. The only current per-answer trust number
below 1.0 is quote fidelity, 0.83–0.89, and a free prompt change is the cheapest falsifiable
intervention — but the correct first move is to measure, not to buy a model.

---

## 1. What the current instrument can and cannot see

### 1.1 The Golden Set is 21 rows, not the planned 50–100

Measured from `packages/kajianq-domain/fixtures/golden-set-v0.json`:

| Property                            | Value                                     |
| ----------------------------------- | ----------------------------------------- |
| Questions                           | 21 (19 `answer`, 2 `refuse`)              |
| Expected source types               | 13 hadith, 8 Quran (two rows expect both) |
| Rows with `citationAlternatives`    | 4 (`006`, `008`, `017`, `022`)            |
| Kitab rows                          | 0                                         |
| Questions with no required citation | 3 (`018`, `019`, `020`)                   |
| Languages                           | 18 Indonesian, 3 English                  |

The planned v1 set is 50–100 questions with a nightly full run and a cross-vendor faithfulness
judge (#20, still open); the chain-aware v2 set (#31) is blocked on #30. The 21-row set is v0, and
its size bounds what any pass/fail claim can mean: with 21 paired rows, the smallest one-way
McNemar swing that reaches p < 0.05 is **six rows**. A two- or three-row improvement is
indistinguishable from a draw at this n.

### 1.2 The deploy gate samples 5 rows and holds out the four hardest

Measured from `packages/kajianq-domain/src/taxonomy.ts` and the latest `Staging` log
([run 41126855005](https://github.com/ahaqqu/KajianQ/actions/runs/41126855005)):

- `SMOKE_HELD_OUT_IDS = ["gs-v0-003", "gs-v0-004", "gs-v0-016", "gs-v0-017"]`. **All four are
  required-hadith-address rows**; their own comment says they are held out because their outcome
  turns on the router's sampled reading or a required citation retrieval cannot ground yet.
- The 5-row sample at `92f95d0` was `019, 020, 018, 015, 001`. Three of the five (`019`, `020`,
  `018`) have **no required citation at all**; the other two require Quran addresses
  (`QS. 1:2`, `QS. 2:255`).
- **No required hadith address is exercised by the deploy gate.** Its five green rows cannot
  distinguish a working hadith citation path from a broken one.
- The smoke calls the harness with `gateAddressRecall: false`
  (`packages/eval/scripts/eval-smoke.mjs`): citation-address recall is printed but does not gate.
  The comment justifies this as "a known-unfixed retrieval miss could redden a deploy for a reason
  unrelated to the change under test" — a rationale written before the caller-priority and
  re-curation fixes, and not revisited since.

### 1.3 The full suite is manual and currently stale

Measured from `.github/workflows/` and the Actions history:

- No workflow runs `eval:run`; only the 5-row `eval:smoke` runs on a merge to `main`. The full
  suite is a manual QA command.
- The last recorded full-suite result is **21/21 on three consecutive draws at `071edf8`**
  (2026-10-27), the merge of #672. That is the strongest accuracy evidence in the repository.
- `92f95d0` is 17 commits later. The answer path changed at least twice after `071edf8`:
  #694 added the per-chain prompt rules 3, 8 and 9 and the chain-evidence record, and #695 wrote
  the Bukhari Sanadset pilot's chains into the store. The 5-row smoke passes at `92f95d0`; the
  21-row suite has **no recorded run at this head**.

### 1.4 Failure attribution exists per row, but not durably

Measured from `packages/eval/src/harness-score.ts`, `packages/contracts/src/trace-events.ts`, and
the eval CLI:

- Per question the harness records `passed`, `sourceTypeRecall`, `citationAddressRecall`,
  `citationValidity`, `refused`, `quoteFidelity`, and the reported `identitySatisfied` block. The
  `failed:` line names the dimension that missed.
- The trace carries `retrieval`, `search_hits`, `rerank`, `review`, `decision` (including the
  citation pre-gate's per-item scores and `skip`/`escalate`), `refusal`, and `chain_evidence`.
- What is missing is the **join from a failed row to its cause**: the harness says _which
  dimension_ missed, not _which stage_ produced the miss, and QA traces are erased after each run
  (the #627 audit records this for its runs), so the failure cannot be re-read from the artifacts.
  There is no stored classification, and no aggregate of reviewer/pre-gate escalations in any
  report field.

**Table 1 — Instrument coverage**

| Surface                 | What it runs                             | What it can redden                               | What it cannot see                                                                  |
| ----------------------- | ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Deploy smoke            | 5 of 21 rows, address reported not gated | source-type recall, citation validity, behaviour | any required hadith address; 4/21 hardest rows; 12/21 never sampled; quote fidelity |
| Full suite (`eval:run`) | 21 rows, all legs                        | pass/fail, address recall, validity              | questions outside the fixture; held-out generalisation; reviewer escalation rate    |
| Golden Set v0           | 21 curated rows                          | —                                                | the 50–100-row v1 (#20); kitab; chain-grade traps (#31)                             |
| Trace                   | per-run events                           | nothing by itself                                | a durable cause label; traces are erased after QA                                   |

---

## 2. Error taxonomy and the evidence

### T1 — Retrieval and ranking

**Mechanism.** One dense vector per corpus row (isnad + matn together), one query vector per
router sub-query, RRF fusion, a per-track cut, and a decision-model reranker. When the required
address is absent from the fused set, the generator either refuses (the prompt's rule 1) or
answers from a neighbour; when it is present but outranked, the generator may cite a sibling.

**Historical evidence — reported, and measured in the research branches:**

- At `3d07155` (2026-10-22), the full set was **15/21**, address recall **0.857**, citation
  validity **0.714**; six rows failed (#627).
- At `9c57893`, #515 measured **8 of 20** required addresses never retrieved; the fused set
  returned neighbours (Bukhari 185/186/191/192 for 149; no `42:*` for 42:11; 5027/5028/4937 for
  5026). Source-type recall still read 1.000, because it counts kinds, not addresses.
- The candidate levers were measured, not guessed:
  - a **reranker** moved required-address rank by +6, +4, +2, +2, +2, +1, 0, 0, 0, 0, −5, −8 and
    changed **zero** verdicts;
  - a **provider switch** (DeepSeek → Ollama) produced 13/21, confounded by one retrieval draw
    and one generator draw;
  - a **lexical-only arm** did not surface the three target rows (best rank #279), so it was not
    built;
  - **matn-only re-embedding** was a no-op for the Quran row and worse for 016; **chapter-label +
    whole row** moved 9/18 to 12/18 top-10 single-vector, but only +2 rows survived serving
    fusion, at a re-embed cost of roughly **$1.32–$1.80** for the 42,511-row Indonesian track;
  - raising the per-track candidate cut **K=10 → 64** would put 016's #48 inside the pool, and
    costs 5–6× candidates per track into RRF and rerank (not measured end to end).

**Fixes that moved the number — reported:** #646 read an ungraded sahihayn row as sahih (14,940
rows previously excluded by a `grade: sahih` filter); #652 always searched the caller's question;
#654 and #663 gave the caller's query a priority arm including the fallback route; #664
re-curated the last three red rows to reachable evidence; #650 retired the unreachable 007 and
added 022. The result was address recall **1.000** and **21/21 on three draws**.

**Current evidence.** The manual full set is green on address recall, but the automated gate has
no required hadith address (1.2), the four hadith-address rows are held out (1.2), and the most
relevant held-out probe in the repository's research branches — the 12-item aqidah held-out set on
`research/647-retrieval`, measured locally against the stored corpus vectors — found **5 of 12
anchors outside the verbatim question's top 50** (ranks 155, 219, 64, 75, and 5,352; the other
seven at ranks 2–19). That is a retrieval-coverage signal, not a proven wrong answer: the corpus
may answer the question from another verse, and the held-out item's anchor is one curator's
choice.

**Verdict.** Retrieval/ranking is the best-evidenced **historical** cause and was substantially
fixed on the curated set. Today it is **unmeasured by the deploy gate** and **not ruled out** by
the held-out probe. It is not honest to call it fixed for questions outside the 21 rows.

### T2 — Citation and evidence handling

**Mechanism.** A deterministic citation gate requires every required label (or a curated
alternative / signed identity) to be present in the answer's grounded evidence; the reviewer
pre-gate screens citations with a cheap decision model and escalates anything it cannot clear; the
paid reviewer runs only on escalation. The citations frame is derived server-side from the trace's
retrieved chunks and the answer's inline spans.

**Historical evidence — reported:** citation validity was **0.450** at `0cf0bcc` (11/20 failed,
mean recall 1.000), **0.450** again at `9c57893` on a different draw, and **0.714** at `3d07155`.
The causes were a collection-spelling split (`Ibnu Majah` vs `Ibn Majah`, `Nasa'i` vs `Nasai`,
fixed #514), an incomplete Matn-identity map (#672), and an over-specific one-address requirement
on rows whose corpus offers several equally valid narrations (#661, #669, #671). The gate now
accepts both signed relations — `same-report` and `same-ruling` — through the owner-signed map,
and the reported identity-satisfied block shows 21/21 on the green draws.

**Current evidence and open shapes:**

- Green draws: citation validity **1.000**, identity **21/21**, source-type recall **1.000**.
- Open #522: `validateCitations` uses `normalizedAnswer.includes(label)`, so a longer label
  (`HR. Bukhari no. 50102`) grounds a shorter required label (`HR. Bukhari no. 5010`) in the
  trace's `grounded` list, which the pre-gate and the eval scorer read. The refusal path still
  refuses because `ungrounded` is read first, so this is bounded, but it is a known false-positive
  shape in the measurement.
- Open #519: a range citation's passage is keyed by its written label, so every range attestation
  comes back empty and the pre-gate escalates. That is fail-open spend, not a false pass.
- The gate now depends on the accuracy of the owner-signed identity map: a wrong `same-ruling`
  member would widen validity silently (ADR-0054's recorded residual).
- The reviewer pre-gate's **escalation rate is unavailable**: the trace has per-item `decision`
  events, but no eval report aggregates them and the traces are erased. We cannot say whether the
  pre-gate clears most answers or escalates most of them.

**Verdict.** Citation/evidence handling was the **dominant residual after retrieval** in the
15/21 era, and the fixes are real. Today's gated metric is green, but it has one known
false-positive shape and an owner-signed-data dependency. It is not the measured dominant cause
today on the available numbers.

### T3 — Generator reasoning and output discipline

**Mechanism.** The generator is instructed to answer only from context, cite every quotation,
show Arabic + translation, present every chain with its own grade, and refuse when the specific
thing asked is absent. It can fail in three observable ways: over-refusal, under-refusal, and
putting words in quotation marks that no cited passage contains.

**Historical evidence — reported:**

- Over-refusal: **2** rows at `0cf0bcc` (`gs-v0-014`, `gs-v0-017`), **6** rows at `9c57893`
  (`006`, `007`, `011`, `014`, `017`, `018`), **0** at `3d07155`. The cleanest case,
  `gs-v0-018`, answered twice and refused once in three fresh sessions with no pinned sampling;
  the attribution was formally **unattributed** (#516). The fix was a re-read of the addressed
  evidence (#649) plus curated alternatives, and the green draws include `018` passing.
- Quote fidelity: **0.828–0.893** across the recorded full-set draws; **0.856–0.883** on the three
  green draws, with 16–20 of 21 answers carrying a measurable quote. The scorer checks whether
  each typographic or straight quoted span appears in the text of **any cited chunk**, not whether
  it is attributed to the right one; it folds case, punctuation, combining marks and Arabic
  orthographic variants; it excludes answers with no quotes rather than counting them perfect.
  It is **report-only and never gates**.
- No structural post-generation validator exists for the grade/claim rules: #694's own PR states
  that an answer which _writes_ an unsupported grade is not rejected; corroboration and takhrij
  rest on the model recognising two passages as the same matn and are prompt-scoped.

**Current evidence.** The green draws have no pass/fail failures attributable to generator
reasoning; the only measured generator defect is quote handling. The 21-row set cannot see a
reasoning failure that happens outside its rows. The refusal path is exercised by `gs-v0-020` in
the smoke, but `gs-v0-019`, the row labelled "refusal coverage", can pass on the grounded branch
(#471), so the label promises more than the row checks.

**Verdict.** Generator **quote discipline** is the only current per-answer trust metric below 1.0
and therefore the only measured leak in this class. There is no evidence of broad generator
reasoning failure on the current set, and the instrument is too small to rule it out.

### T4 — Domain data gaps

**Mechanism.** Answers can only be as trustworthy as the evidence the corpus carries: grades,
kitab, and clean translations.

- **Per-chain grades are all null.** The S2 Bukhari pilot wrote **5,602 chains on 5,504 v1
  children**; the live adapter returns them with resolved sanads and **null grades**. The S3 grade
  producer is a **no-go**: no legally usable per-chain source names its grader, and ADR-0066
  refuses an unattributed grade. #30 stays open as the record of the missing live path.
- **14,940 sahihayn rows carry no grade** (7,580 Bukhari + 7,360 Muslim); #646 resolves this for
  the filter by reading an ungraded sahihayn row as sahih, which is a collection-level assumption,
  not a per-chain grade.
- **No kitab rows.** The recorded corpus is 42,511 children: 35,982 hadith, 6,236 Quran, 293 test
  fixtures. The domain pack's own filter comment says `kitab` is a source the corpus does not carry
  yet; the Golden Set has **zero** kitab questions, so the product's kitab claim is untested by the
  gate. #21 (one kitab end to end) and #22 (kitab scale-out) are open.
- **A translation is truncated upstream**: `gs-v0-008`'s Indonesian layer ends mid-sentence and
  loses the second half of the matn (#627 phase C). That is a data-quality defect in the only
  layer an Indonesian question can match.

**Verdict.** These are real trust and coverage gaps, but none is demonstrated as the cause of a
wrong answer on the current 21 rows, and none is fixed by a model swap. The grade gap cannot be
bought: the lawful source does not exist, and guessing is the exact violation the product refuses.

### T5 — The measurement gap (the meta-cause)

The four classes above cannot be separated today because the instrument cannot see them:

1. 21 rows, not 50–100 (#20).
2. 4 of the 21 — all required-hadith-address rows — are held out of the automated gate.
3. The automated gate does not gate address recall.
4. The full suite is manual and its last run predates the current answer path.
5. Quote fidelity and identity-satisfied are report-only.
6. The reviewer pre-gate's escalation rate is not aggregated.
7. QA traces are erased, so a failure's cause cannot be re-read.
8. There is no held-out set on `main`; the one this brief uses lives on a research branch.

**Table 2 — Error taxonomy, current verdict**

| Class                  | Best evidence                                                                                                        | Current status                                                                                     | Can it explain today's wrong answers?                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1 Retrieval / ranking | 0.857 address recall at `3d07155`; 8/20 addresses never retrieved at `9c57893`; 5/12 held-out anchors outside top-50 | Fixed on the 21 curated rows (1.000 ×3); unmeasured by the deploy gate; held-out signal unresolved | **Yes, outside the fixture; unknown on it**                      |
| T2 Citation / evidence | validity 0.450 → 1.000; #522 false-positive shape; #519 range fail-open; map-dependent                               | Gated green; one known false-positive shape; escalation rate unavailable                           | **Possible but not measured**                                    |
| T3 Generator           | over-refusal 6 → 0; quote fidelity 0.828–0.893 report-only; no structural grade validator                            | Only quote handling is currently below 1.0                                                         | **Yes for trust; not for factual wrongness**                     |
| T4 Domain data         | grades null; 14,940 ungraded sahihayn; no kitab; one truncated translation                                           | No lawful grade source; kitab unbuilt                                                              | **Yes for coverage/trust; not measured as a wrong-answer cause** |
| T5 Measurement         | 5/21 smoke with no hadith address; full suite manual and stale; traces erased                                        | Structural                                                                                         | **This is why the answer above is "unknown"**                    |

---

## 3. Current measurable baseline

Numbers only where they exist; otherwise **unavailable**. The distinction between "reported" and
"measured here" is stated per row.

| Metric                            | Value                                                                                         | As of                          | Provenance                                            | Label                              |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ---------------------------------- |
| Golden Set size                   | 21 rows (19 answer / 2 refuse; 13 hadith / 8 Quran; 4 alternative rows; 0 kitab)              | `92f95d0`                      | `packages/kajianq-domain/fixtures/golden-set-v0.json` | measured (read)                    |
| Manual full-set pass              | **21/21**, three consecutive draws                                                            | `071edf8`, 2026-10-27          | #376 closing comment                                  | reported                           |
| Full-set pass at current head     | **unavailable** (no recorded run after #694/#695)                                             | `92f95d0`                      | Actions history; no `eval:run` workflow               | measured (absence)                 |
| Deploy smoke pass                 | **5/5**                                                                                       | `92f95d0`, run 41126855005     | Actions log                                           | reported                           |
| Smoke sample                      | `019, 020, 018, 015, 001`; 4 held out (`003, 004, 016, 017`)                                  | `92f95d0`                      | Actions log + `taxonomy.ts`                           | reported / measured (code)         |
| Smoke required hadith addresses   | **0**                                                                                         | `92f95d0`                      | fixture + log                                         | measured (read)                    |
| Mean source-type recall           | 1.000 on the green draws; 1.000 on the 5-row smoke                                            | `071edf8` / `92f95d0`          | #376 / Actions log                                    | reported                           |
| Mean citation-address recall      | 1.000 on the green draws; 1.000 on the 5-row smoke (reported, not gated)                      | `071edf8` / `92f95d0`          | #376 / Actions log                                    | reported                           |
| Mean citation validity            | 1.000 on the green draws; 1.000 on the smoke                                                  | `071edf8` / `92f95d0`          | #376 / Actions log                                    | reported                           |
| Identity-satisfied rows           | 21/21 green draws; 5/5 smoke                                                                  | `071edf8` / `92f95d0`          | #376 / Actions log                                    | reported                           |
| Mean quote fidelity               | **0.828–0.893** full-set draws; **0.856–0.883** on the three green draws; 16–20/21 measurable | `071edf8` and prior draws      | #376 comments, #664                                   | reported                           |
| Over-refusals                     | 2 (`0cf0bcc`) → 6 (`9c57893`) → 0 (`3d07155`); 0 on the green draws                           | historical                     | #376, #516                                            | reported                           |
| Full-run cost                     | $0.129887–$0.142711 across the recorded full-set draws                                        | the draws                      | #376                                                  | reported                           |
| Smoke cost                        | $0.031034 (5 answers) → $0.0062/answer                                                        | `92f95d0`                      | Actions log                                           | reported                           |
| Held-out aqidah anchors reachable | 7/12 reachable (ranks 2–19); 5/12 outside the verbatim top-50                                 | local exact cosine, 2026-10-23 | `research/647-retrieval` branch, not re-run here      | measured (prior)                   |
| Ungraded sahihayn rows            | 14,940 (7,580 Bukhari + 7,360 Muslim)                                                         | 2026-10-22                     | #647 evidence                                         | measured (prior)                   |
| Per-chain grades                  | all null; 5,602 chains / 5,504 children                                                       | S2 pilot                       | #30 comment                                           | reported                           |
| Kitab rows                        | 0 of 42,511                                                                                   | recorded corpus                | #647 / `filters.ts`                                   | measured (prior) / measured (code) |
| Reviewer pre-gate escalation rate | **unavailable**                                                                               | —                              | no aggregate in report or repo                        | unavailable                        |
| Golden Set v1 (50–100)            | not built (#20 open)                                                                          | —                              | issue tracker                                         | reported                           |

**What is actually established.** The product has a green **manual** full-set draw on a curated
21-row set, and a green **automated** 5-row gate that does not test a required hadith address.
It does not have a current, automated, per-row measurement of the classes that used to fail.

---

## 4. Ranked interventions

Ranked by expected leverage on a **measurable** outcome per unit of cost, not by ambition. The
order is deliberately not the order in the dispatch.

| Rank | Intervention                                             | Mechanism                                                                                                                                     | Expected leverage                                                                                                                             | Cost                                                                                              | Risk                                                                                | Verdict                                                                                                       |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | **Generator quote discipline** (prompt-only)             | Rewrite rule 4: quote only text copied exactly from a cited passage; otherwise paraphrase **outside** quotation marks. No new component.      | Moves the only per-answer trust metric below 1.0 (0.83–0.89). A plausible target is +4–6 trust-clean rows; unknown until run.                 | 1 prompt edit + 1 staging deploy; ~$0.42 for two full draws.                                      | Prompt compliance may be partial; may reduce quote coverage.                        | **Try first.** Cheapest falsifiable change; no model purchase.                                                |
| 2    | **Reviewer quote verification** (deterministic de-quote) | After generation, remove quotation marks around any span not found in a cited chunk; leave the words as paraphrase. Reuses the scorer's fold. | Forces unverified quotes to zero by construction; could reach 21/21 trust-clean.                                                              | ~50–80 lines + tests + 1 deploy; ~$0.42 for two draws.                                            | More machinery; may remove quotes the user values; must be gated by quote coverage. | **Fallback only if #1 fails.** Test it against #1, not instead of it.                                         |
| 3    | **Retrieval candidate window K=10 → 64**                 | One config change; more candidates per track into RRF/rerank.                                                                                 | No gain on the 21-row set (address already 1.000). At best +1/5 held-out anchors (rank 64); ranks 75/155/219 remain outside.                  | 0 model calls; 5–6× candidates; rerank/context tokens unmeasured.                                 | Dilution, latency, cost; may not move a verdict.                                    | **Measure only if the baseline fails on retrieval.** Not a first buy.                                         |
| 4    | **Router determinism / query rewrite**                   | Remove the sampled category's effect; the caller-priority arm already guarantees the caller's top hits.                                       | Low on current rows; no failing row is attributed to it after #654/#663.                                                                      | Low code/config cost.                                                                             | Reopens routing semantics; could change filters.                                    | **Hold.** The failure mode is already covered by the caller-priority arm.                                     |
| 5    | **Reviewer pre-gate instrumentation**                    | Aggregate the existing `decision` events: how often does it skip vs escalate, and do escalated answers fail?                                  | No behaviour change; tells whether the reviewer is a cause or a cost.                                                                         | Free read of traces or one report field; one run's data.                                          | None.                                                                               | **Do this as part of measurement, not as a fix.**                                                             |
| 6    | **Arabic/domain embedder**                               | Re-embed with a domain or chapter-context representation.                                                                                     | Measured: chapter-label + whole row moved 9/18 to 12/18 top-10 single-vector, but only +2 rows survived fused retrieval; matn-only was worse. | $1.32–$1.80 for the 42,511-row Indonesian track, plus eval re-baseline and a new corpus snapshot. | New baseline; corpus-wide change; not reversible cheaply.                           | **Do not buy on current evidence.** The required addresses are already retrieved on the set.                  |
| 7    | **Reranker**                                             | Decision-model reorder of fused candidates.                                                                                                   | Measured: +6 to −8 rank movement, **zero** verdict changes.                                                                                   | Per-query model call; adds a provider dependency.                                                 | Cost and latency for no measured accuracy.                                          | **Do not buy.**                                                                                               |
| 8    | **Corpus / grade evidence**                              | Licensed per-chain grades, kitab corpus, clean translations.                                                                                  | High trust value, but the lawful per-chain source does not exist; kitab is a product build, not a model fix.                                  | S3 no-go; kitab ingestion is a multi-ticket programme (#21/#22).                                  | Guessing grades would violate the product's core rule.                              | **Cannot buy the grade half; do not fake it.** Fund kitab only as a product decision, not as an accuracy fix. |

### What not to buy, in plain language

- **Do not buy a new embedder.** The current one already puts every required address into the
  full-set retrieval; the measured gain from a different representation is two rows out of
  eighteen, and it costs $1.32–$1.80 plus a new baseline. That is a large bill for a number that
  may not move.
- **Do not buy a reranker.** It was measured on production traffic: it moved the required
  citation's rank by up to six places and changed **no** pass/fail verdict.
- **Do not buy per-chain grades.** There is no lawful source that names the grader. The product's
  own rule refuses an unattributed grade for good reason; filling the gap from model memory is the
  exact failure the citation gate exists to prevent.
- **Do not swap the generator model.** Nothing in the evidence isolates model knowledge as the
  cause. The one measured output defect — words in quotation marks that are not in the cited text
  — is a prompt/output contract issue, and a model swap would not fix a contract.
- **Do not add a second vendor.** It doubles cost and trace complexity and has no measured
  accuracy case; the Ollama switch produced 13/21 against 15/21, confounded by draws.

---

## 5. The experiment matrix

### 5.1 The question

> On the current build, does a **verbatim-only quote rule** reduce unverified quotations and raise
> the share of answers that are both gate-passing and quote-clean — and if the prompt alone does
> not, does a **deterministic de-quote pass** close the gap without destroying quote coverage or
> raising refusals?

This is the cheapest test that can falsify the claim in §0. It does not touch retrieval, the
embedder, the corpus, or the model.

### 5.2 Arms

| Arm   | Change at the same commit                                                                                                                                                                      | What it tests                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **B** | Current head, no change                                                                                                                                                                        | Baseline: how much of the trust gap exists today                |
| **G** | Prompt rule 4 rewritten: quote only text copied exactly from a cited passage; if you cannot copy it, paraphrase **without** quotation marks. No other prompt or code change.                   | Can the generator be trusted with a clearer output contract?    |
| **R** | G plus a deterministic post-pass: for each quoted span not found in the text of any cited chunk (same fold as `quoteAppearsIn`), remove the quotation marks and leave the words as paraphrase. | Is enforcement needed, and what does it cost in quote coverage? |

`R` is a **ceiling arm**, not a quality arm: it reaches a perfect quote score by removing the
claim of verbatimness. Its value is measured by the coverage guardrail, not by the quote score.

### 5.3 Sample size and power

- **Rows:** all 21 Golden Set rows, same fixture version, same corpus snapshot label, same staging
  URL.
- **Draws:** 2 independent staging draws per arm (fresh sessions, fresh run ids, no replay).
- **Answers:** 21 × 2 × 3 = **126** scored answers; 42 per arm; 21 paired row-level outcomes.
- **Power:** with 21 paired rows, the smallest one-way McNemar swing at α = 0.05 is **6 rows**
  (exact p = 0.031). For the continuous quote-fidelity metric, 21 paired means detect roughly a
  **0.09** shift at 80% power if the per-row standard deviation is 0.15. If the expected effect is
  smaller than either, **this matrix cannot see it**; expand the set (#20) before spending.
- **Held-out guard:** one baseline run of the 12-item aqidah held-out probe (from the
  `research/647-retrieval` branch, to be re-authored or adopted by the owner) is a **class check**,
  not an arm. If its answer refuses or cites an address other than the anchor while the anchor is
  absent from the retrieved set, the cause is retrieval, not quote discipline; the matrix's
  conclusion is then scoped to the Golden Set and the next experiment is retrieval.

### 5.4 Pass/fail metric

- **Primary — trust-clean (per row, per arm):** the row's harness `passed` is true **and**
  `quoteFidelity === 1` for a row that carries at least one quoted span. A row that was quote-free
  at baseline and stays quote-free is clean; a row that quoted at baseline and becomes quote-free
  is reported and does **not** count as clean, so an arm cannot win by deleting quotations. A row
  counts for the arm only if it is trust-clean in **both** draws; a skipped or unmeasured draw is
  not clean.
- **Secondary — mean quote fidelity** over answers with a measurable quote (the existing scorer's
  denominator, 16–20/21), **quote coverage** (quoted spans per answer, and the share of baseline
  quotes retained), **gate pass count**, **citation validity**, **address recall**, **refusal
  count**, **cost per answer**.
- **Guardrails:** gate pass must stay ≥ **20/21** in both draws; refusals must not rise by more
  than **1/21**; quote coverage must stay ≥ **80%** of the baseline's quoted spans.

### 5.5 Decision rule, fixed before the run

1. Ship **G** only if trust-clean improves by **≥ 6/21** over B and gate pass stays ≥ 20/21 in both
   draws. A smaller gain is not distinguishable from noise at n = 21; report it as inconclusive
   and expand the set.
2. If G fails, ship **R** only if trust-clean reaches **21/21**, quote coverage is ≥ 80% of B, and
   refusals rise by ≤ 1/21. Otherwise reject both.
3. If both fail, do not buy a model. The finding is "the 21-row set is too small to see this
   improvement"; the next ticket is Golden Set v1 (#20), not an embedder.

### 5.6 Confounders

- **Sampling:** the router and generator are sampled; `temperature: 0` is inert in DeepSeek's
  thinking mode and no seed is exposed (#539). Two draws per arm is the minimum to see a draw;
  three would be better but exceeds the cap once the held-out run is included.
- **Already-landed changes:** #694's chain prompt and #695's chain data are in **all** arms. The
  experiment measures quote discipline on top of them, not their effect.
- **Vendor drift:** a provider-side model change mid-run would masquerade as an arm effect. Run
  the arms interleaved (B, G, R, R, G, B) and record model ids from the trace.
- **Trace erasure:** persist the run ids and per-row report before the QA session is erased; the
  replay fixture is not a substitute for a fresh draw.
- **Frame text availability:** quote fidelity is unmeasured when the citations frame carries no
  cited text (1–5 rows). Report the denominator every time; do not read a perfect mean over 16
  answers as a perfect mean over 21.
- **Scorer scope:** the scorer checks existence in **any** cited chunk, not attribution to the
  right one. A quote that appears somewhere in the context but beside the wrong citation passes;
  this experiment cannot detect that stricter failure.
- **Identity-map edits:** any change to `hadith-identities-v0` during the run changes validity;
  freeze the map for the experiment.

### 5.7 Spend cap and stop rules

- **Projected spend:** 126 answers at the latest measured $0.0062/answer ≈ **$0.78**, plus 12
  held-out answers ≈ **$0.07**, total ≈ **$0.86**. At the older $0.0068/answer it is ≈ **$0.94**.
- **Cap:** **$1.00** (the task default). Hard stop at **$0.95**, leaving room for a retry.
- **If a full run costs more than $0.16:** cut to **1 draw per arm** (63 answers, ≈ $0.43) and
  label the result a screening run, not a stability claim.
- **Stop before any arm** if the baseline's gate pass is **< 19/21**: the failing leg names the
  cause and the matrix is the wrong experiment.
- **Stop** if the baseline's trust-clean is **≥ 19/21**: there is no headroom for a 6-row gain.
- **Stop** if any arm's refusal rate rises by **> 2/21** or quote coverage falls below **80%** of
  baseline: reject that arm for user-visible regression, regardless of its quote score.
- **Stop** at **$0.95** and report the partial matrix; a partial honest result beats an overrun.

### 5.8 What would prove it, and what would refute it

**Proves the claim (and justifies the free fix):**

- G raises trust-clean by ≥ 6/21 with gate pass ≥ 20/21, and mean quote fidelity rises from
  ~0.86 to ≥ 0.95, with quote coverage within 80% of baseline.
- Or R reaches 21/21 trust-clean with no meaningful loss of quotes or rise in refusals, showing
  that enforcement, not generation, was the missing piece.

**Refutes the claim:**

- B already has trust-clean ≥ 19/21, or G and R do not move either metric.
- The held-out baseline shows a failed row whose failing leg is retrieval/address recall — the
  cause is T1, not T3.
- The only way R reaches a perfect score is by removing most quotes (coverage < 80%) — that is
  hiding the claim, not verifying it.
- An answer's quote checks out against a cited chunk but is attributed to the wrong citation —
  the scorer's existence-only scope means this experiment cannot see it; a different measurement
  is needed.

---

## 6. Recommendation in plain language

**Measure this first.** Run the current build's full 21-row Golden Set **twice**, plus one run of
the 12-item held-out aqidah probe, with the per-row legs and the quote-fidelity denominator
printed. That costs about **$0.35–$0.45**, takes under an hour, and answers the question the
repository currently cannot: is the 21/21 a stable property of this build, or a memory of the
27 October build? It also tells you whether the held-out failures are retrieval (address absent)
or answer behaviour (refused or cited a neighbour).

**If forced to pick one intervention now, pick the free one.** Tighten the generator's quotation
rule: quote only what is copied exactly from a cited passage; otherwise paraphrase without
quotation marks. It costs one prompt line and one staging deploy, it targets the only measured
per-answer trust number below 1.0, and it does not touch the corpus, the embedder, or the model.
That is also the answer to "not more machinery": try the prompt first; add the deterministic
de-quote pass only if the measurement shows the prompt cannot hold.

**Do not buy** an embedder, a reranker, a generator swap, or per-chain grades on this evidence.
The reranker was measured and changed no verdict; the embedder's best measured representation
moved two fused rows and was never run to a verdict; the generator swap has no measured accuracy
case; grades have no lawful source. A model swap would be a guess dressed as progress.

**What would prove it.** Quote fidelity at or above 0.95, trust-clean up by at least six of 21
rows, gate pass at or above 20/21, and no loss of quote coverage. If the prompt does not move it,
the deterministic de-quote pass is the next test — but only if it keeps at least 80% of the quotes
and does not raise refusals.

**What would change the answer.** A baseline run that fails on address recall, or a held-out
probe that fails on retrieval, moves the cause back to T1. Then the next experiment is the
candidate window K=64 (cheap) or a curated chapter-context representation (expensive), not the
quote rule. The measurement decides; the model purchase waits.

---

## 7. Decisions

### D1 — Do not swap the model, embedder, or reranker (hold)

**Evidence.** Reranker: +6 to −8 rank movement, zero verdict changes. Embedder: +2 fused rows at
best, $1.32–$1.80 re-embed. Current full set: every required address retrieved on the green
draws. **Why it matters.** A swap would reset the baseline and spend money without a measured
mechanism. **Default if nobody rules.** No purchase; the current build stands. **What would
change it.** A fresh run with a retrieval-leg failure on rows the current build cannot fix, or a
held-out set where a representation lift is measured end to end.

### D2 — Measure the current head before the next accuracy ticket (recommended)

**Evidence.** The 21/21 is from `071edf8`; the head is `92f95d0` with #694/#695 after it. The
deploy gate tests no required hadith address. **Why it matters.** Without this, every accuracy
claim is about a build that no longer exists. **Default if nobody rules.** The stale 21/21 stands,
and the green 5/5 is read as accuracy evidence it is not. **What would change it.** A recorded
full-set run at the head with per-row legs and quote fidelity; or a decision that the 21-row set
is retired in favour of #20's 50–100.

### D3 — If one change ships now, ship quote discipline, not machinery (recommended)

**Evidence.** Quote fidelity 0.828–0.893 is the only sub-1.0 per-answer trust metric; rule 4 does
not currently require verbatim copying. **Why it matters.** It is the cheapest test of whether
the generator can be trusted to represent evidence honestly. **Default if nobody rules.** Quote
fidelity stays around 0.86 and the trust gap is unaddressed. **What would change it.** G fails the
pre-registered margin; then test R, or expand the set before buying anything.

### D4 — Expand the Golden Set before claiming small gains (hold until D2)

**Evidence.** n = 21, MDE = 6 rows; the planned v1 is 50–100 (#20); no held-out set on `main`.
**Why it matters.** A 2–3-row improvement — the plausible size of a prompt fix — is invisible at
this n, so a "win" would be a coin flip. **Default if nobody rules.** The set stays at 21 and
small improvements remain unmeasurable. **What would change it.** A measured effect large enough
for 21 rows, or an owner decision to fund the v1 curation.

---

## Appendix A — Evidence ledger

| Id  | Claim                                                                                                                               | Source                            | Stream                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------- |
| E1  | Full set 15/21, address 0.857, validity 0.714 at `3d07155`                                                                          | #376, #627                        | reported                           |
| E2  | 8/20 required addresses never retrieved at `9c57893`                                                                                | #515                              | reported                           |
| E3  | 21/21 three consecutive draws at `071edf8`; address/validity/identity 1.000; costs $0.129887–$0.136282                              | #376 closing comment              | reported                           |
| E4  | Quote fidelity 0.828–0.893; 0.856–0.883 on the green draws; 16–20/21 measured                                                       | #376 comments, #664               | reported                           |
| E5  | Reranker +6..−8 rank, zero verdict change; Ollama 13/21 vs DeepSeek 15/21; lexical best #279; chapter-context +2 fused, $1.32–$1.80 | #627 comments                     | reported                           |
| E6  | Held-out aqidah: 7/12 reachable, 5/12 outside top-50                                                                                | `research/647-retrieval` evidence | measured (prior, not re-run)       |
| E7  | 14,940 ungraded sahihayn rows; 42,511 corpus rows; 0 kitab                                                                          | #647, `filters.ts`                | measured (prior) / measured (code) |
| E8  | All per-chain grades null; 5,602 chains / 5,504 children; S3 no-go                                                                  | #30 comments                      | reported                           |
| E9  | Smoke 5/5 at `92f95d0`, $0.031034, sample `019/020/018/015/001`, no hadith address                                                  | Actions run 41126855005           | reported                           |
| E10 | `SMOKE_HELD_OUT_IDS` = 003/004/016/017; all hadith-address rows; smoke `gateAddressRecall: false`                                   | `taxonomy.ts`, `eval-smoke.mjs`   | measured (code)                    |
| E11 | 21-row composition, 0 kitab, 3 no-citation rows                                                                                     | `golden-set-v0.json`              | measured (read)                    |
| E12 | Quote-fidelity scorer known cases pass (19 tests)                                                                                   | local run                         | measured                           |
| E13 | #522 `includes` containment; #519 range passage empty; #471 refusal row can pass grounded                                           | issues                            | reported                           |
| E14 | #20 v1 50–100 open; #31 v2 open; #30 grades open                                                                                    | issues                            | reported                           |
| E15 | Reviewer pre-gate escalation rate absent from report fields                                                                         | code read + issue history         | measured (absence)                 |

## Appendix B — Reproduction notes

- The fixture read: `packages/kajianq-domain/fixtures/golden-set-v0.json`.
- The scorer known-case check:
  `bunx vitest run packages/eval/src/quote-fidelity.test.ts` → 19 passed.
- The smoke policy: `packages/eval/scripts/eval-smoke.mjs` (`gateAddressRecall: false`).
- The held-out list: `packages/kajianq-domain/src/taxonomy.ts` (`SMOKE_HELD_OUT_IDS`).
- The latest smoke: `gh run view 41126855005 --log` (sample, summary, cost).
- The full-set history: #376 comments, especially the closing 21/21 comment; #515, #627, #647.
- No paid call, no DB read/write, no production change was made for this brief.
