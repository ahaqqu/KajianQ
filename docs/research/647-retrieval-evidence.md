# Retrieval for the four remaining Golden Set rows — evidence (#647)

Scope: the retrieval half of #627, continued as #647. The identity/equivalence instruments are
merged (`784ac5a`, `2b29b0c`); this note asks only what puts the four required addresses into the
retrieved set, what the concept→anchor table holds, what a held-out set looks like, how #647's
≥3-deployed-run stability figure is measured, and what each candidate costs and moves.

Every number is labelled:

- **measured** — a command I ran against the local read-only corpus
  (`doc_children`, 42,511 rows; `embedding_primary`, gemini-embedding-001, 1536 dims) or a file I
  read at head. The command is in [`647-experiments.md`](647-experiments.md).
- **reported** — quoted from a committed artefact or a prior run, with its source. I did not
  re-run it.
- **not measurable here** — a quantity this environment cannot produce. Named as a limit, never
  estimated into a number.

## Brief (committed before E1)

### The claim under test

> **C1 — reachability.** For each of 007, 011, 016 and 008, at least one representation that costs
> at most one extra embedding and no per-query LLM call puts the required address inside a top-K
> (K ≤ 50) over the local corpus. The exception is 007: no question-side representation reaches it,
> and the only cheap mechanism that does is a curated concept→anchor table whose per-query cost is
> zero when no anchor matches.
>
> **C2 — the table's content.** A concept→anchor table stores the concept and the anchor address
> together, and the matcher is the thing that needs measuring, not the anchor's retrieval: an
> address can be read from `doc_children` directly, so the anchor is never a similarity problem.
> A usable table is small (one entry per aqidah concept the product must serve), and its marginal
> query cost is zero because it reuses the query vector the retriever already computed.
>
> **C3 — the stability figure.** A local repeat of one run cannot support #647's ≥3-deployed-run
> stability claim, because exact cosine rank over a static, stored index is deterministic by
> construction. Stability needs three independent deployed draws compared on the same inputs.

### Kill conditions

- **C1 dies** if a row has no representation at K ≤ 50 that is cheaper than a per-query LLM call —
  then that row's option is "expensive path" or "curation", not retrieval.
- **C1 dies for 007 specifically** if a question-side representation that does not contain the
  verse's text reaches `QS. 42:11` at K ≤ 10. That is the measured falsifier the prior packet left
  open (E6 there: best non-quoting shape #56).
- **C2 dies** if the trigger measurement shows a keyword/concept matcher cannot separate the
  aqidah questions from the rest of the fixture without firing on the controls, or if the number of
  concepts a usable table needs is not bounded (i.e. every question needs its own concept).
- **C3 dies** if the three deployed draws differ on a row whose local rank is identical — that
  does not refute C3, it confirms the difference between local determinism and deployed draw
  variance; C3 is refuted if a _local_ repeat is offered as the stability evidence.

### The decision it unblocks

#647's retrieval scope: which representation ships per row, whether the concept→anchor table is
built (and with what matcher), and what the ≥3-run stability gate must execute. Named owner
decisions inside: 007's curated table and its held-out acceptance set.

### Budget

8 experiments, ≤$0.50 paid spend, wall-clock one session. Query embeddings cost ~$0.00001 each;
this environment currently exposes **no embedding or LLM credential** (see §Limits), so the plan
runs every zero-cost measurement first and reserves one experiment id for a credentialed run if a
key arrives.

### Deliverable

This file (decision brief) plus [`647-experiments.md`](647-experiments.md) (`E<n>` ids, stable,
appended as each ends). No production change, no corpus write, no deployed environment touched.

## Limits stated up front

- **No vendor credential in this environment (measured).** `DEEPSEEK_API_KEY` and `GEMINI_API_KEY`
  are commented out in `apps/api/.env`; no such variables exist in the process environment; the
  only populated secret files under `~/.config/kajianq/` carry `DATABASE_URL`, Cloudflare and R2
  keys. Consequence: I cannot embed a new query text, so no **question-side** representation
  (verbatim question, HyDE passage, concept-description similarity) is measurable here. Those
  numbers appear below **reported**, never extrapolated.
- **The deployed fused set is not this measurement.** Everything measured here is exact cosine
  rank over the stored `embedding_primary` — one retriever's candidate ranking, not the deployed
  router + lexical + RRF + decision-rerank pipeline. A local rank is necessary, not sufficient.
- **The corpus is read-only and static.** Every session ran under
  `SET default_transaction_read_only = on`; no row was written, no embedding recomputed.

### Credential correction (appended after the brief was committed, before E2)

The manager located the keys in the shared checkout's root `.env`, which this session had not
read: `GEMINI_API_KEY` / `GEMINI_PAID_API_KEY` (53 chars) and `DEEPSEEK_API_KEY` (35 chars). The
limit above was true of `apps/api/.env` and of the process environment, and false of the machine.
Every question-side measurement below is therefore **measured**, not reported — except where a
figure is explicitly marked as a prior researcher's reported value. No key was written to a
file in this worktree, and none is printed in the log.

## 1. What was measured, per row and per representation

Exact cosine rank over `doc_children` (42,511 rows; 35,982 hadith / 6,236 Qur'an / 293 untyped —
measured). Rank is `1 + count(distance < required row's distance)`. The verbatim row is the
Golden Set question; `K` is the cut at which the required address would enter a candidate pool.
"Source" says what the deployed system would have to do to obtain that vector: `0 emb` = reuse a
stored row's own vector (one address read, no vendor call); `1 emb` = one extra query embedding,
no LLM; `1 llm + 1 emb` = an LLM call per query.

### 007 — required `QS. 42:11` (E2, E3, E6)

| representation                                                       | source        | rank / 42,511 | within Qur'an | K needed |
| -------------------------------------------------------------------- | ------------- | ------------: | ------------: | -------: |
| verbatim Golden Set question                                         | 0 (the query) |     **5,352** | 1,017 / 6,236 |   >5,000 |
| the verse's own translation (oracle quote)                           | 1 emb         |             1 |             1 |        1 |
| quote-shaped passage, LLM-written (measured #84; prior reported #23) | 1 llm + 1 emb |            84 |            83 |       84 |
| concept paraphrase 1 ("sifat wajib… tanzih…")                        | 1 emb         |         1,952 |           285 |    1,952 |
| concept paraphrase 2 ("Maha Mendengar… setara")                      | 1 emb         |        **17** |            16 |       17 |
| HyDE passage                                                         | 1 llm + 1 emb |         1,133 |           567 |    1,133 |
| question + address appended                                          | 1 emb + addr  |         1,335 |           561 |    1,335 |
| sibling verse `QS. 6:103` vector                                     | 0 emb         |        **43** |            43 |       43 |
| sibling verse `QS. 112:4` vector                                     | 0 emb         |           198 |           197 |      198 |
| neighbour `QS. 42:12` vector                                         | 0 emb         |           226 |           226 |      226 |
| neighbour `QS. 42:10` vector                                         | 0 emb         |         2,794 |         2,131 |    2,794 |

**No representation that a question can produce reaches a top-10 cut.** The best is a
curator-written concept paraphrase at **#17**, then a doctrinal sibling verse's stored vector at
**#43**. Both are inside a top-20/top-50 pool; neither is a citation. The prior researcher's
figures for the same shapes differ (#56 for a concept expansion, #23 for a quote-shaped passage,
#582 for HyDE) because the texts were generated by a different prompt and model draw — a
difference the next section treats as evidence, not noise.

### 011 — required `HR. Muslim no. 534` (E2, E3, E6)

| representation                              | source        |  rank | K needed |
| ------------------------------------------- | ------------- | ----: | -------: |
| verbatim Golden Set question                | 0             | **8** |        8 |
| vocabulary rewrite ("bersuci… setengah")    | 1 emb         |     2 |        2 |
| the row's own matn (oracle quote)           | 1 emb         |     1 |        1 |
| identity twin `Tirmidhi 3517` stored vector | 0 emb         |     2 |        2 |
| identity twin `Ibn Majah 280` stored vector | 0 emb         |     4 |        4 |
| identity twin `Nasai 2437` stored vector    | 0 emb         |     4 |        4 |
| question + address appended                 | 1 emb + addr  |     5 |        5 |
| quote-shaped passage, LLM-written           | 1 llm + 1 emb |     8 |        8 |
| HyDE passage                                | 1 llm + 1 emb |    21 |       21 |

**011 is already in the top ten of the user's own query.** Its recorded miss is not a
representation problem; §3 gives the mechanism the code and the corpus support.

### 016 — required `HR. Bukhari no. 1395` (E2, E3, E6)

| representation                               | source        | rank | K needed |
| -------------------------------------------- | ------------- | ---: | -------: |
| verbatim Golden Set question                 | 0             |   48 |       48 |
| identity twin `Nasai 2435` stored vector     | 0 emb         |    6 |        6 |
| identity twin `Ibn Majah 1783` stored vector | 0 emb         |    7 |        7 |
| identity twin `Abu Dawud 1584` stored vector | 0 emb         |    9 |        9 |
| identity twin `Nasai 2522` stored vector     | 0 emb         |    9 |        9 |
| the row's own matn (oracle quote)            | 1 emb         |    1 |        1 |
| quote-shaped passage, LLM-written            | 1 llm + 1 emb |   24 |       24 |
| question + address appended                  | 1 emb + addr  |   79 |       79 |
| concept paraphrase                           | 1 emb         |  275 |      275 |
| HyDE passage                                 | 1 llm + 1 emb |  413 |      413 |
| neighbour `Bukhari 1396` vector              | 0 emb         |  188 |      188 |

Under the verbatim question the twins themselves sit at #111–#160 (E3): the query does not
retrieve a sibling either. The row is reachable **in a K=50 pool by rank and not in a K=10
pool**, and reachable at #6–#9 only if a curated twin is the _query_.

### 008 — required `HR. Bukhari no. 5026`, fixture any-of `{5027, 4937}` (E2, E3)

| representation / address under the verbatim question | source         |  rank | K needed |
| ---------------------------------------------------- | -------------- | ----: | -------: |
| required `Bukhari 5026`                              | 0              |   397 |      397 |
| **any-of member `Bukhari 4937`**                     | 0 (same query) | **4** |        4 |
| any-of member `Bukhari 5027`                         | 0 (same query) |    12 |       12 |
| `Bukhari 5028` (not in the set)                      | 0 (same query) |     8 |        8 |
| the row's own matn (oracle quote)                    | 1 emb          |     2 |        2 |
| neighbour `Bukhari 5025` vector → 5026               | 0 emb          |     7 |        7 |
| identity/alternative `4937` vector → 5026            | 0 emb          |   111 |      111 |
| concept paraphrase                                   | 1 emb          |   132 |      132 |
| quote-shaped passage, LLM-written                    | 1 llm + 1 emb  |   152 |      152 |
| HyDE passage                                         | 1 llm + 1 emb  |   302 |      302 |

**The required address is not reachable cheaply; an owner-signed member of its any-of set is
reachable at #4 by the user's own question.** `citationAddressRecall` at head reads the
alternatives (measured in `packages/eval/src/scorers-address.ts`: `[citation, ...alternatives]`),
and only `gs-v0-008` carries the field (1 of 21 rows, measured).

## 2. Per-row options, ranked by measured recovery

Cheapest first. "Recovery" is what the measurement says enters the pool; whether the generator
then cites it is not measurable locally and is stated as the residual risk in every row.

### 007 — **the concept→anchor table is the only measured path; nothing cheaper qualifies**

1. **Curated concept→anchor injection** — the anchor is read by address, never retrieved by
   similarity (no query-side representation above reaches top-10; the anchor's own vector is not
   even the best sibling, #43). Cost: 0 embeddings and 0 LLM calls per query, one address read on
   a match; curation per entry. This is the option D5 anticipated and the only one whose
   coverage does not depend on the question's wording.
2. **Concept paraphrase issued as an extra query, K ≥ 20** — 1 embedding, no LLM, lands the
   verse at #17. Strictly weaker than (1) (it needs the candidate to survive reranking, which the
   archived E7 measured at roughly half), but it is the cheapest thing that ever reached the
   verse from a question-shaped text.
3. **Quote-shaped passage, K ≥ 100** — 1 LLM call per query, #84. Expensive, and the shape
   succeeds by writing the verse's own words, which is the failure mode D5 was ruled against.
4. HyDE (#1,133), address-augmented (#1,335), neighbour/scope vectors (#43–#2,794): none puts
   the address in a usable cut. A sibling verse's vector is cheap but only helps if the table
   already knows which sibling — at which point it can name the anchor.

### 011 — **zero retrieval work: the cause is a filter that is already fixed at head**

1. **`grade: sahih` filter expansion (#646, merged at `2b29b0c`)** — the corpus stores no grade
   for 14,940 sahihayn rows (7,580 Bukhari + 7,360 Muslim, measured); before #646 the filter
   `grade = 'sahih'` excluded every one of them, which is exactly "32 sahih hadith retrieved,
   none of them this one". `Muslim 534` is ungraded (`metadata->>'grade'` null, measured). At
   head the expansion admits it, and its verbatim rank is #8.
2. **Twin-as-query fallback** — if a deployed draw still drops it, a curated twin's stored vector
   puts it at #2 (`Tirmidhi 3517`, cosine 0.967), 0 embeddings, one address read.
3. **Vocabulary rewrite** ("kebersihan"→"bersuci", "sebagian"→"setengah") — 1 embedding, #2; a
   cheaper deterministic fix than any LLM call if a wording fix is wanted at all.

### 016 — **K, then curation, then a metric ruling**

1. **Raise the per-track candidate K from 10 to ≥64.** 0 embeddings, 0 LLM calls; the required
   row is #48 locally and #61 in the recorded draw (reported), so K=64 contains both. Cost is
   5–6× candidates per track per sub-query into RRF and rerank. Reversible by config.
2. **Twin injection** — a curated `Abu Dawud 1584`/`Nasai 2435` vector as an extra query puts
   1395 at #6–#9 (0 embeddings, curation only). It does not satisfy the exact-address gate on its
   own; it makes the pool contain the address that the identity map already accepts.
3. **D4 (identity-satisfied address recall)** — the #627 packet's measured lever: flips 016 and
   only 016, at the cost of the metric's meaning. Now dominated by (1), which recovers the
   required address itself.
4. Quote-shaped (#24), address-augmented (#79), concept (#275), HyDE (#413): not in top-10.

### 008 — **the merged any-of instrument, not retrieval**

1. **Keep `Bukhari 4937` in the fused set.** The verbatim query ranks it #4; the merged
   `citationAlternatives` path accepts it for address recall (code read + measured rank). No
   retrieval change, no embedding, no curation beyond the owner's existing signature.
2. **Extend the any-of set with `Bukhari 5028`** (#8 under the same query) — a curator ruling,
   data-only, reversible; 5028 is not currently a member.
3. **Concept→anchor entry for the exact address** — only if the owner wants 5026 itself cited;
   #397 by rank, #7 via `Bukhari 5025`'s stored vector (5025 shares 0.052 5-gram Jaccard with
   5026 — a neighbouring narration, not an identity, so it cannot enter the set as an equivalence).

## 3. Why 011 and 008 failed, measured rather than assumed

- **011.** `Muslim 534` carries `metadata.grade = null` and `collection = muslim` (measured).
  `sahihFilterExpansion` did not exist before #646; #646's own commit message states the defect:
  "a `grade: sahih` filter excluded every one of their rows". `effectiveGrade` at head resolves
  the null to `sahih` for exactly the two collections (code read), and the expansion is attached
  to the filter as data at `storeFilters` (code read). The measured blast radius is 14,940 rows
  that a `grade: sahih` filter now matches and the hierarchy bonus now scores.
- **008.** The dispatched cause ("the fused set returns 5027/5028/4937") is confirmed at the
  retrieval layer: the verbatim query ranks 4937 #4 and 5028 #8 (measured). The instrument that
  turns that into a pass is `citationAlternatives`, and it is at head. So 008's retrieval half is
  "do not lose 4937"; its content half is the curator's set, which is signed.

## 4. The concept→anchor design for 007

### 4.1 What the table contains

One entry per concept, and **not** the question:

| field              | measured basis                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `concept` (id)     | the unit the owner rules on; 1 entry served each of the 9 concepts measured (E4/E5)                |
| `doctrine` (gloss) | the claim the anchor is evidence for; a curator's sentence, not corpus text                        |
| `anchor` (address) | one address, verified to exist as exactly one `doc_children` row (9/9 measured)                    |
| `conceptLabel`     | the matcher's embedding target; similarity to the question is the strongest measured matcher (4.2) |
| `triggers`         | the keyword matcher's terms; measured brittle on paraphrase (4.2)                                  |
| curator signature  | the same rule as `hadith-identities-v0`: a human signs it, code never does                         |

The anchor is a **pointer read by address**, not a retrieval target: no question-side
representation measured puts `QS. 42:11` in a top-10 cut, and the anchor's own vector is not the
best route to it (#43 via `QS. 6:103`). The table therefore never embeds the anchor — it reads
the row.

**Where it lives.** The DB already carries an empty concept graph — `concept`, `lemma`,
`concept_links`, `concept_relation`, `lemma_evidence`, all **0 rows** (measured). Their schema is
a lemma/relation/evidence model with no column for matcher material; populating them would force
every entry through a lemma + `ayah_pair` shape, and the trigger lexicon would need a migration.
The cheaper home is a curated domain fixture beside `hadith-identities-v0.json` (data-only,
owner-signed, reversible) with the concept graph left for the larger Principle Index programme.
That is a design recommendation to be ruled on; both are reversible.

### 4.2 How a question is mapped to an anchor — three matchers measured

Nine concepts, nine held-out questions plus two LLM paraphrases each (27 cases), and the 20
Golden Set questions that are not 007 (20 controls; 17 non-aqidah plus 3 no-requirement rows).

| matcher                              |                                                              true cases |                      controls fired | per-query cost (measured)                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------: | ----------------------------------: | ---------------------------------------------------------------------------------------------- |
| **A — keyword trigger lexicon**      |                                    9/9 originals, **11/18 paraphrases** |                            **0/20** | 0 embeddings, 0 LLM, string match                                                              |
| **B — cosine question↔conceptLabel** |                                                **27/27 argmax correct** |                  **0/20** at τ≥0.66 | 0 embeddings (reuses query vector), 9 full 1536-dim cosines = **2,525 µs pure Python**, 54 KiB |
| **C — LLM classifier to concept id** | 8/9 originals, 8/9 + 8/9 paraphrases, but **0/3 on 007's own question** | **2/20** (`gs-v0-005`, `gs-v0-019`) | 1 LLM call, **$0.000048/query** measured                                                       |

The threshold sweep (E7) is the safety number for matcher B: true-item similarity ranges
**0.715–0.923**, control best-similarity **0.501–0.646**, so the window in which B fires on every
true case and on no control is **τ ∈ [0.66, 0.70]** — a 0.04-wide window fitted in-sample. Outside
it, the design either misses (τ > 0.72) or false-fires (τ < 0.64).

**Recommendation, on the measurement:** matcher B as the primary, matcher A as a deterministic
audit trail (it explains _why_ an anchor fired, and it is what a curator reviews), matcher C
rejected — it is the most expensive, it fails the one question the table exists for, and it
invents anchors for two controls.

### 4.3 Coverage: how many concepts, and what each costs

- The measured ratio is **one entry per concept** (9 concepts / 9 questions), so a table that
  must serve the _k_ aqidah concepts the product supports needs _k_ entries.
- The table-dependent class is the minority: of the 12 held-out questions measured, only **5**
  have an anchor outside the verbatim question's top-50 (4 distinct concepts). The other 7 are
  reachable today (ranks 2–19) and the table must not change them.
- **The 20 canonical _sifat wajib_ cannot be built by term lookup.** With word boundaries, 1 of
  20 names (`ilmu`, 48 Quran rows) occurs literally in the corpus's Indonesian translations; 0
  for `qidam`, `baqa`, `wahdaniyah`, `qudrah`, `kalam`, `mukhalafat`, `qiyamuhu binafsihi`,
  `hayat`, `sami'`, `bashar`, `iradah`, … (`sama`, 127 rows, is the Indonesian homonym
  "same", not the attribute). Each entry needs a curator who knows which verse evidences which
  attribute; the corpus cannot supply the mapping.
- **Cost per entry, measured where machine and named where human:** 1 embedding of the concept
  label ≈ 60 tokens ⇒ **$0.000012 list price, $0 free tier**; 1 SQL existence read ⇒ $0. The
  curator's review time is not measurable in this session and is not estimated here.
- **Per-query cost when no anchor matches: zero.** No extra embedding (the matcher reuses the
  query vector the retriever already computed), no LLM call, no SQL; the only cost is the
  similarity computation, measured at 2.5 ms for 9 concepts in pure Python (implementation-
  dependent; a vectorised matcher is strictly cheaper). Per matched query: one address read.

### 4.4 Open questions the measurement cannot close

1. **Threshold transfer.** The 0.66–0.70 window was fitted on 9 concepts and 20 controls, with
   concept labels the researcher wrote. With 20–50 concepts the nearest-neighbour ceiling rises
   (`wahdaniyah` vs `uluhiyah` already sit 0.07 apart on held-out questions), so τ must be
   recalibrated on a curator-written table — and every recalibration is a gate-affecting number.
2. **Who writes the lexicon, and blind to what.** The keyword matcher was written with the
   questions in view; the 11/18 paraphrase recall is therefore an upper bound. The owner's
   curator must write triggers against a held-out set they have not seen, or the recall figure is
   circular.
3. **Does a question ever need two concepts?** The design injects the argmax concept's anchor
   only. A question about, say, `qudrah` and `ilmu` would get one anchor; the measured clean
   window does not cover multi-label questions because none was in the set.
4. **Does the generator cite an injected anchor?** Not measurable locally. The anchor enters the
   candidate set and the trace must show the injection; whether the answer cites it is the
   ≥3-run measurement.
5. **Where the injection sits relative to RRF and the reranker.** A locally injected candidate
   that RRF scores by rank position will rank below every retrieved candidate. Whether it must be
   a separate labelled slot (like the corpus label lookup at #620) is an implementation decision
   the brief cannot make; the measurement only says the row will not be found any other way.

## 5. The held-out set

`research/647/heldout-aqidah-v0.json` plus the E5 additions. **N = 12, none of them 007**, each
with a corpus-verified address. Two strata, because the first draft's eight items were mostly
reachable and a set that cannot contain the failure cannot demonstrate the fix:

**S1 — table-dependent (the design must serve these; verbatim rank > 50).**

| #   | concept             | question (abridged)                                        | anchor      | verbatim rank | quote falsifier (shared run / content Jaccard) |
| --- | ------------------- | ---------------------------------------------------------- | ----------- | ------------: | ---------------------------------------------- |
| 1   | tanzih/mukhalafat   | Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?  | `QS. 42:11` |         5,352 | 1 / 0.000                                      |
| 2   | qudrah              | Apakah kekuasaan Allah meliputi segala sesuatu?            | `QS. 2:20`  |           155 | 2 / 0.036                                      |
| 3   | qudrah (paraphrase) | Bagaimana dalil bahwa kekuasaan Allah tidak terbatas?      | `QS. 2:20`  |           219 | 0 / 0.000                                      |
| 4   | uluhiyah            | Mengapa hanya Allah yang boleh disembah?                   | `QS. 2:163` |            64 | 1 / 0.000                                      |
| 5   | ilmu/hati           | Apakah Allah mengetahui isi hati manusia yang tersembunyi? | `QS. 57:6`  |            75 | **3 / 0.333 — echoes the verse; flagged weak** |

**S2 — near-controls (reachable today; the table must not disturb them).** `QS. 112:1` (#4),
`QS. 6:103` (#11), `QS. 55:27` (#18), `QS. 6:59` (#19), `QS. 4:164` (#2), `QS. 2:255` (#7),
`QS. 57:3` (#2).

**How each was chosen.** Doctrine from the Ahlus Sunnah aqidah set (tawhid, tanzih, the divine
attributes, prophethood, revelation); question authored in Indonesian from the doctrine's meaning;
anchor read from `doc_children` by address and verified to exist exactly once; the verbatim dense
rank then measured, and the item assigned to S1/S2 by the measured rank, not by intent. The quote
falsifier is measured per item: the longest run of consecutive question tokens present in the
anchor's text, and the content-word Jaccard. Item 5 is retained as flagged: it shares three
content words and a 3-token run with its verse, so a pass there would not distinguish the table
from a lexical match.

**What would falsify the design.**

- An S1 item where the matcher does not fire (coverage miss) — the 9-concept probe was 27/27, but
  the threshold window is in-sample.
- An S1 item where the matcher fires for the wrong concept (the argmax is another entry).
- An S2 item whose rank or pass state moves when the table is on — blast radius.
- An S1 item whose question, stripped of the anchor's own content words, no longer fires: that is
  the "only works because it quotes the verse" failure, and item 5 is the one already suspected.
- A held-out aqidah question that quotes nothing and whose anchor is _already_ in the top-10:
  evidence the table is unnecessary for that concept (not a failure, but it shrinks the table's
  justification to the S1 class).

## 6. Measurement protocol for the ≥3-deployed-run stability figure

**What to run.** Three independent deployed runs of the whole Golden Set at one commit, each with
its own run id and a **fresh, retained trace**; nothing replayed, nothing re-scored from a stored
frame. Same fixture version, same corpus snapshot label. Independence is per run, not per day:
the sources of draw-to-draw variance are the router's sub-queries (LLM), the decision rerank
(LLM), RRF order, filter relaxation, and the neighbour/scope expansions — so each run must
regenerate all of them.

**What to compare, per row (all 21, not the mean):** the retrieved candidate set with each
candidate's rank; which required/alternative/identity addresses appear in it; the cited label set
from the frame; `citationValidity`, `citationAddressRecall` (exact), the identity-satisfied
figure (reported), pass/fail; and, if the table ships, whether an anchor was injected and which
concept fired.

**What counts as stable.**

- the row's pass state is identical on 3/3 draws;
- the required address (or a signed alternative) is in the retrieved set on 3/3;
- the cited label **set** is identical on 3/3 for the rows the change targets;
- the address's rank stays inside the measured band, not at an identical integer: 011's local
  margin is 0.0013 above / 0.0014 below with 3 rows within 0.002 (measured), and 016's local
  #48 vs recorded #61 (reported) already shows a ±13 spread between a local and a deployed draw.
  A protocol that demands the same integer would fail a change that is in fact stable.

**A false "stable" looks like:**

- **The same run scored twice.** Measured: three embeddings of the same question are bit-identical
  (pairwise cosine 1.000000) and rank identically (5,352 / 8), so a local repeat can never vary —
  it is structurally incapable of falsifying stability.
- **Replaying the recorded draw.** #627's cited sets came from runs whose traces were erased; a
  comparison to them is a comparison to a quotation, not a draw.
- **Aggregating pass counts.** Two draws can swap which rows pass and keep the count; the archived
  E12 saw coverage move 8/18 ↔ 9/18 with truncated passages, which an aggregate would report as
  "roughly stable".
- **Counting a stable failure.** A row that fails 3/3 is stable and still broken; the protocol must
  report the per-row direction, not only agreement.
- **A fixed threshold.** Matcher B's window is 0.04 wide in-sample; a run at a different concept
  count can change firing with no change to any question, which looks like instability in the
  system and is really drift in the table.

## 7. Blast radius and cost

| candidate                      | rows whose numbers move (measured)                                                                                                                               | reversible by                 | incremental cost per query (measured)                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| 011 `#646` filter expansion    | every ungraded sahihayn row: **14,940** (7,580 Bukhari + 7,360 Muslim); 006/016/017 validity and any future `grade: sahih` filter                                | reverting one commit / config | 0 embeddings, 0 LLM                                                                                    |
| 008 any-of set (merged)        | **1 fixture row** (`gs-v0-008` is the only `citationAlternatives` row, measured); members are address-satisfying for it only                                     | deleting the field            | 0                                                                                                      |
| 016 K 10→64                    | **all 21 rows**: 5–6× candidates per track per sub-query into RRF/rerank; the only rank change measured is the injected-slot displacement (+1), not a reordering | config                        | 0 embeddings, 0 LLM; rerank/context cost not measured                                                  |
| 007 concept→anchor (matcher B) | **3 rows** if it fires on the 3 aqidah-ish controls — measured **0/20** controls fire at τ ≥ 0.66; every extra concept raises the ceiling (open)                 | deleting data / flag          | 0 embeddings, 0 LLM, 2.5 ms for 9 concepts (pure Python)                                               |
| 007 concept paraphrase + K≥20  | all 21 rows (one extra query each): 5× candidates, rerank decides                                                                                                | config/flag                   | 1 embedding per query, no LLM                                                                          |
| HyDE or quote-shaped anywhere  | all 21 rows: one LLM call per query, candidate pool +1 per row                                                                                                   | config/flag                   | 1 LLM call: **$0.000095/query** (measured: 74 prompt + 60.5 completion tokens at $0.30/$1.20 per MTok) |

The 008 and 011 instruments are already merged, so their blast radius is already live and does not
need this brief's permission; what remains is the retrieval-side decision for 007 and 016.

**What a run costs** is not measurable locally: a deployed run's spend is the router + reranker +
generator per question, and none of those three is exercised here. What this brief prices is the
_incremental_ retrieval half, per query, in the table above. The whole research session's paid
spend is in §9.

## 8. Decisions

### D-P1 — 007's retrieval: build the concept→anchor table, matcher B primary (recommend: yes, as a flagged path)

**Evidence.** E2: no question-side representation reaches top-10 (best #17); E4/E7: matcher B is
27/27 with a 0/20 control record inside a 0.66–0.70 window; matcher C fails 0/3 on 007's own
question; E5: 1/20 sifat names exist in the corpus's own words, so curation is the only source.
**Why it matters.** This is the one row where a retrieval decision buys a product behaviour; the
alternative is to leave 007 unreachable.
**Default if nobody rules.** The table is built as a research prototype only and no pipeline
change ships; 007 stays out of reach.
**What would change the answer.** A question-side representation that reaches `QS. 42:11` at
K ≤ 10 without containing the verse (refutes the need); or a curator-written table where the
0.66–0.70 window collapses (refutes matcher B).

### D-P2 — 016's retrieval: raise K before changing any metric (recommend: K=64, measure on 3 runs)

**Evidence.** E2/E6: required address #48 by rank, inside a K=50 pool and outside K=10; recorded
draw #61 (reported); E3: no sibling is retrieved by the verbatim query.
**Why it matters.** It recovers the exact address without touching `citationAddressRecall`'s
meaning, which D4 would have changed for every historical number.
**Default if nobody rules.** Keep K=10 and 016 stays a retrieval residual (its #627 D4 option
remains open but is no longer the first choice).
**What would change the answer.** Three deployed runs at K=64 that still do not put 1395 in the
retrieved set (then K is not the lever, and curation is).

### D-P3 — 011 and 008: no retrieval change (recommend: close their retrieval halves)

**Evidence.** 011 #8 verbatim + the pre-#646 filter mechanism (code + 14,940 ungraded sahihayn
rows) and #646 merged; 008's any-of member 4937 #4 verbatim and `citationAlternatives` at head.
**Why it matters.** Building a representation for a row that is already reached spends money and
adds risk for no recovery.
**Default if nobody rules.** Nothing is built; the ≥3-run protocol verifies both.
**What would change the answer.** A deployed run whose fused set does not contain 534 or 4937 —
then the fallback in §2 applies (twin vector / vocabulary rewrite, both measured).

### D-P4 — the held-out set becomes the acceptance set for any table (recommend: adopt S1, re-author it with a curator)

**Evidence.** §5: 12 items, addresses verified, S1/S2 split by measured rank, one item flagged for
quoting its verse.
**Why it matters.** Without it, the table can be validated only against the questions it was built
from — the exact circularity the brief exists to avoid.
**Default if nobody rules.** The set stays a research proposal and no table ships.
**What would change the answer.** A curator who re-authors S1 blind to the concept labels, or an
S1 item that the matcher cannot hit.

### D-P5 — the stability gate (recommend: 3 deployed runs, per-row, with bands)

**Evidence.** E6: local determinism (3/3 identical) and the 011 near-tie margin (0.0013/0.0014,
3 rows within 0.002); §6 lists the false stables.
**Why it matters.** #647's acceptance criterion is a ≥3-run figure; a protocol that replays one
run would satisfy it falsely.
**Default if nobody rules.** Report per-row results of whatever runs exist, labelled as a single
draw, and do not claim stability.
**What would change the answer.** A demonstrated source of deployed-run determinism (e.g. a fixed
seed and temperature 0 across every stage) would let one run stand — not measured here.

## 9. Spend and limits

**Paid spend: $0.0064 measured** (vendor `usage` × recorded peak price), against the $0.50 cap:

| experiment                       | LLM calls | prompt + completion tokens |          cost |
| -------------------------------- | --------: | -------------------------: | ------------: |
| dry-run prompt tests (before E2) |         5 |                388 + 2,276 |     $0.002850 |
| E2 (4 HyDE + 4 quote-shaped)     |         8 |                  592 + 484 |     $0.000758 |
| E4 (9 paraphrase calls)          |         9 |                  795 + 276 |     $0.000570 |
| E5 (47 classifier calls)         |        47 |                6,859 + 168 |     $0.002259 |
| **total**                        |    **69** |                            | **$0.006437** |

Embeddings ran on the free-tier key (`GEMINI_API_KEY`, configured price 0); the number of
embedding HTTP calls is ~120 with ~30-token inputs, a list-price equivalent of **< $0.001
(estimate)**. No corpus embedding was recomputed.

**Limits.** (1) Everything here is exact cosine over `embedding_primary`; the deployed pipeline's
secondary track, router sub-queries, RRF, filter relaxation and decision rerank are not exercised
— a local rank is necessary, not sufficient. (2) The held-out questions and the concept labels
were written by this researcher, not a curator; the matcher's 27/27 is in-sample for the
threshold. (3) Whether the generator cites an injected or newly retrieved address needs deployed
runs. (4) The 20-sifat coverage question is answered by count of literal terms, which bounds the
lexical route only, not the number of concepts a product needs. (5) No deployed environment, no
corpus write, no re-embed: 42,511 rows before and after (measured), every session read-only.

## 10. What would refute this brief

- A question-side representation reaching `QS. 42:11` at K ≤ 10 without containing the verse —
  removes D-P1's premise.
- A deployed run that puts 534 or 4937 in the fused set without #646 / the any-of path — would
  mean the recorded misses had a different mechanism and the "already fixed" claim is wrong.
- Three deployed runs at K=64 where 1395 is still absent from the retrieved set — removes D-P2.
- A curator-written table where matcher B's clean window closes (true and control similarities
  overlap) — removes the matcher recommendation, leaving the keyword path or the tool loop.
- An S1 item the matcher cannot hit, or an S2 item that moves — the accepted blast radius is one
  candidate slot, nothing more.
- Any row whose required address the local corpus reaches differently from what this log recorded
  — the harness is then the bug, and E1 is where to look.
