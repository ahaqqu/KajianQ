# Experiment log — #647 retrieval

Append-only: one entry per experiment, written as it ends and never rewritten. `E<n>` is the
stable id the decision brief cites. Every command is copy-pasteable from the worktree root
`.worktrees/research-647-retrieval`; the database session sets
`SET default_transaction_read_only = on` before every statement.

Cost lines state what was actually called. Embeddings run on the free-tier key
(`GEMINI_API_KEY`), whose configured price is 0
(`packages/infra/src/providers/models.json`), so no invoice is produced; where a list-price
equivalent is given it is an **estimate** from measured token counts, labelled as such. LLM calls
report the vendor's `usage` block, so their cost is computed from measured tokens at the
configured price.

---

## E1 — can the rank harness be believed before its numbers count?

**Question.** Does the local exact-cosine harness score cases whose answer is already known?

**Setup.** `research/647/harness.py --selfcheck`: (a) four target rows each queried with their
own stored `embedding_primary` — every one must rank 1 at distance 0; (b) three live query
embeddings, two of which have a documented figure to reproduce (`QS. 42:11`'s own translation
**reported #1**, the 007 verbatim question **reported #5352**, from the #627 packet E6) and one
whose figure comes from the archived research (`gs-v0-011` verbatim question, **reported #11**,
`docs/research/experiments.md` E8 on `refs/heads/research/archive`). All ranks are exact
`1 + count(distance < target distance)` over 42,511 rows.

**Command.**
`python3 research/647/harness.py --selfcheck`

**Result.**

| known case                               | expected (reported) | measured | delta |
| ---------------------------------------- | ------------------: | -------: | ----: |
| 007 self-vector (`QS. 42:11`)            |            rank 1.0 |        1 |     0 |
| 008 self-vector (`Bukhari 5026`)         |            rank 1.0 |        1 |     0 |
| 011 self-vector (`Muslim 534`)           |            rank 1.0 |        1 |     0 |
| 016 self-vector (`Bukhari 1395`)         |            rank 1.0 |        1 |     0 |
| 007 verse's own translation as the query |                   1 |        1 |     0 |
| 007 verbatim question                    |               5,352 |    5,352 |     0 |
| 011 verbatim question                    |                  11 |        8 |    −3 |

**Verdict.** Confirmed for the harness: the self-vector cases pin the rank arithmetic (a wrong
index or an off-by-one would move them), and the 007 verbatim question reproduces 5,352 exactly.
The 011 figure differs by three ranks from the archived probe; the cause is not identifiable from
here (the archived command's exact query string is not preserved in a runnable form, and this
session's vector is a fresh vendor call). **Consequence for later entries: a ±3 rank difference
is not attributable, so no result in this log turns on a difference smaller than that.**

**Cost.** 5 embedding HTTP calls, free-tier key, configured price 0 (list-price equivalent
< 200 input tokens ⇒ **<$0.00004, estimate**); no LLM call. Wall clock 23 s.

---

## E2 — per-row reachability under each candidate representation

**Question.** For each of 007, 011, 016 and 008, which representation puts the required address
in the top-K, and what does it cost per query?

**Setup.** `research/647/e2-representations.py`. Four rows × representations: the verbatim Golden
Set question; the required row's own matn (an _oracle_ quote of the row, the ceiling, not a
deployable representation); one or two curator-voice concept paraphrases with no LLM; a HyDE
passage (one `deepseek-v4-flash` call, `temperature: 0`, `reasoning_effort: none`); a quote-shaped
passage (one LLM call, the E9 shape); the verbatim question with the required address appended
(one embedding, but it needs an address source); the identity/any-of twin rows queried by their
**stored** vectors (0 embeddings); and the neighbouring addresses queried by their stored vectors
(0 embeddings), plus three doctrinal sibling verses for 007. Every vector is ranked against all
42,511 rows; rank is exact.

**Command.**
`python3 research/647/e2-representations.py`

**Result.** 45 representations (the full table is §1 of the evidence brief; this is the shape of
it). Selected rows, rank over 42,511:

| row | representation                                    | source                |               rank |
| --- | ------------------------------------------------- | --------------------- | -----------------: |
| 007 | verbatim                                          | 0 embeddings          |              5,352 |
| 007 | own translation (oracle)                          | 1 emb                 |                  1 |
| 007 | concept paraphrase 1 / 2                          | 1 emb each            |     1,952 / **17** |
| 007 | HyDE                                              | 1 llm + 1 emb         |              1,133 |
| 007 | quote-shaped (LLM)                                | 1 llm + 1 emb         |                 84 |
| 007 | address-augmented                                 | 1 emb + addr          |              1,335 |
| 007 | sibling verse `6:103` / `112:4` / `59:22` vectors | 0 emb                 | **43** / 198 / 463 |
| 007 | neighbours `42:12` / `42:10` vectors              | 0 emb                 |        226 / 2,794 |
| 008 | verbatim                                          | 0                     |                397 |
| 008 | twin/alternative `5027` / `4937` vectors          | 0 emb                 |          153 / 111 |
| 008 | neighbour `5025` vector                           | 0 emb                 |                  7 |
| 011 | verbatim                                          | 0                     |              **8** |
| 011 | vocabulary rewrite ("bersuci… setengah")          | 1 emb                 |                  2 |
| 011 | twins `3517` / `280` / `2437` vectors             | 0 emb                 |      **2** / 4 / 4 |
| 011 | HyDE / quote-shaped                               | 1 llm + 1 emb         |             21 / 8 |
| 016 | verbatim                                          | 0                     |                 48 |
| 016 | twins `1584` / `1783` / `2522` / `2435` vectors   | 0 emb                 |  9 / 7 / 9 / **6** |
| 016 | quote-shaped / HyDE / concept                     | 1 llm + 1 emb / 1 emb |     24 / 413 / 275 |
| 016 | neighbour `1396` vector                           | 0 emb                 |                188 |

**The harness bug the first run caught.** The model's first two calls returned empty content: with
reasoning left on, `deepseek-v4-flash` spends the entire `max_tokens` budget in
`reasoning_tokens` and emits nothing (measured: 900/900 and 1,500/1,500 completion tokens, content
`''`). `reasoning_effort: "none"` fixes it (79 prompt + 150 completion, content present). A HyDE
probe that treated empty content as a query would have measured the empty string against the
corpus and reported a rank for nothing.

**Verdict.** Confirmed for 011 and 016; **refuted for 007** as a representation problem — no
question-shaped text reaches a top-10 cut, the best cheap shape is #17 and the best zero-embedding
shape is a sibling verse's stored vector at #43. 008's required address is #397; an owner-signed
alternative is #4. Next experiment: whether a sibling address the gate already accepts is in the
verbatim top-K (E3), and what the per-row near-tie margins are (E6).

**Cost.** 8 LLM calls, 592 prompt + 484 completion tokens = **$0.000758** measured at the recorded
peak price; ~25 embedding HTTP calls on the free-tier key (configured price 0; <$0.0002 list-price
estimate). Wall clock 2 min 32 s.

---

## E3 — does the verbatim question retrieve an address the gate already accepts?

**Question.** If the user's own wording already puts a signed alternative or identity member in
the top-K, the row needs no new representation — the instrument alone closes it.

**Setup.** `research/647/e3-siblings.py`: for each row, the verbatim question's vector (cached
from E2) ranked against every sibling address: the fixture's any-of members, the identity groups'
members, the neighbours, and the doctrinal sibling verses. Zero vendor calls when the vector was
cached; 4 embeddings otherwise.

**Command.** `python3 research/647/e3-siblings.py`

**Result.**

| row | sibling                                                                |             rank under the verbatim question |
| --- | ---------------------------------------------------------------------- | -------------------------------------------: |
| 007 | `QS. 59:22` / `42:12` / `6:103` / `112:4` / `42:9` / `42:10` / `42:11` | 44 / 839 / 557 / 4,034 / 591 / 7,052 / 5,352 |
| 008 | `4937` / `5028` / `5027` / `5026` / `5025`                             |               **4** / **8** / 12 / 397 / 438 |
| 011 | `534` / `3517` / `280` / `2437`                                        |                         **8** / 25 / 42 / 75 |
| 016 | `1395` / `1584` / `2435` / `1783` / `2522`                             |                   48 / 111 / 121 / 125 / 160 |

**Verdict.** Confirmed and consequential. 008's any-of member `4937` is **#4** under the question
the user actually asks; 011's required address is **#8**. 016's twins are all _outside_ the pool
(#111–#160), so no identity instrument closes 016 by retrieval. 007's nearest sibling is `59:22`
at #44 — an asma verse, not the doctrine asked for. Next: the concept matcher (E4).

**Cost.** 0 vendor calls (all vectors cached), $0; wall clock 58 s dominated by exact-rank SQL.

---

## E4 — the concept→anchor table: content, matcher, held-out set, falsifiers

**Question.** What must the table hold, how is a question mapped to it, and does a held-out set
exist that can falsify it?

**Setup.** `research/647/heldout-aqidah-v0.json` (8 items) plus `research/647/e4-concept-anchor.py`:
anchor existence and verbatim rank per item; lexical overlap between question and anchor (the
quote falsifier); matcher A (trigger lexicon) and matcher B (cosine to the concept label) over the
originals, two LLM-written paraphrases each, and the 20 non-007 Golden Set questions as controls;
the per-query cost of the no-match path measured in-process.

**Command.** `python3 research/647/e4-concept-anchor.py`

**Result.** Held-out anchors: verbatim ranks **#4, #11, #19, #7, #2, #2, #155, #64** — five of
eight are already reachable, so the set as first authored could not demonstrate the fix; §5 of the
brief restructures it into S1 (unreachable, the table's class) and S2 (reachable controls).

| matcher                 |      originals |      paraphrases | controls fired |
| ----------------------- | -------------: | ---------------: | -------------: |
| A keyword lexicon       |            9/9 |            11/18 |       **0/20** |
| B cosine question↔label | **9/9 argmax** | **18/18 argmax** |       **0/20** |

Matcher B similarities: true items 0.715–0.923; controls 0.501–0.646. No-match path: 9 concepts,
54 KiB, **2,525 µs per query** in pure Python for 9 full 1536-dim cosines.

**Verdict.** Confirmed that the table holds concept + anchor + matcher material, and that the
anchor is read by address (never retrieved: #5,352 verbatim, #43 as the best sibling vector).
Matcher B is the strongest measured matcher; matcher A is deterministic and precise but loses
7/18 paraphrases. Next: an LLM classifier as the third matcher, more table-dependent items, and
whether the corpus's own words can supply the 20 attributes (E5).

**Cost.** 9 LLM calls, 795 prompt + 276 completion tokens = **$0.000570** measured; ~55 embedding
calls free-tier. Wall clock 73 s.

---

## E5 — a third matcher, two more table-dependent items, and the corpus support for curation

**Question.** Is an LLM concept classifier a better matcher, and can the 20 canonical attributes
be derived from the corpus's Indonesian text?

**Setup.** `research/647/e5-matcher-c.py`: four further held-out candidates authored with
scholastic vocabulary, kept only if the anchor's verbatim rank is outside top-50; one classifier
call per case over 47 cases (9 originals + 18 paraphrases + 20 controls); and a count of the 20
sifat names as literal strings in Qur'an translation rows.

**Command.** `python3 research/647/e5-matcher-c.py`

**Result.**

| extra candidate        | anchor      | verbatim rank | kept?                                                                      |
| ---------------------- | ----------- | ------------: | -------------------------------------------------------------------------- |
| qiyamuhu binafsihi     | `QS. 2:255` |             3 | no (reachable)                                                             |
| baqa / kekal           | `QS. 55:27` |            18 | no (reachable)                                                             |
| qudrah, tidak terbatas | `QS. 2:20`  |       **219** | **yes**                                                                    |
| ilmu, isi hati         | `QS. 57:6`  |        **75** | **yes** (flagged: shares 3 content words and a 3-token run with the verse) |

Classifier: **42/47** overall, but **0/3 on 007's own question** (`none` every time) and **2/20
controls false-fired** (`gs-v0-005` → `wahdaniyah-esa`, `gs-v0-019` → `ilmu-ghaib`); cost
**$0.000048/query** measured.

Corpus support, word-boundary match: `ilmu` 48 rows, `sama` 127 rows; **0** for `qidam`, `baqa`,
`wahdaniyah`, `qudrah`, `kalam`, `mukhalafat`, `qiyamuhu`, `hayat`, `bashar`, `iradah`, `sama`,
`bashiran`, `mutakalliman` (and the rest). `sama` is the Indonesian homonym "same", not the
attribute; the meaningful count is **1/20**.

**The harness bug this caught.** The first count used `LIKE '%sama%'` and reported 309 rows for
the attribute `sami'`, which is `sama` the homonym plus every word containing it. Word-boundary
matching cut it to 127 and the homonym check removed it entirely. A count that measures substrings
of Indonesian would have argued the corpus carries vocabulary it does not.

**Verdict.** Matcher C **refuted** as the primary matcher: costliest, fails the row the table
exists for, false-fires on controls. Curation is the only route to the 20 attributes (1/20 appear
in the corpus's own words). Next: determinism, near-tie margins, baseline reproduction (E6).

**Cost.** 47 LLM calls, 6,859 prompt + 168 completion tokens = **$0.002259** measured; 4 embedding
calls free-tier. Wall clock 63 s.

---

## E6 — what a ≥3-run stability figure must measure, and what a false stable looks like

**Question.** Can a local repeat stand in for #647's three deployed runs, and how wide is a rank
statement?

**Setup.** `research/647/e6-stability.py`: the same question embedded three times, pairwise cosine
and the rank each produces; the rank of the required row plus its gap to the predecessor and
successor under the verbatim query; and the four reported baselines re-measured.

**Command.** `python3 research/647/e6-stability.py`

**Result.**

| measure                         | 007                          | 011                          |
| ------------------------------- | ---------------------------- | ---------------------------- |
| pairwise cosine of 3 embeddings | 1.000000, 1.000000, 1.000000 | 1.000000, 1.000000, 1.000000 |
| rank from each                  | 5,352 / 5,352 / 5,352        | 8 / 8 / 8                    |

Near-tie margins: 011 sits at **#8**, cosine 0.637134, gap to #7 **0.001323**, gap to #9
**0.001436**, **3 rows within 0.002** (neighbours: Tirmidhi 3519, Nasai 5004, Nasai 5006, Tirmidhi
2614). 007, 008 and 016 are outside the top-60, so no local margin exists for them.

Baselines: 007 reported 5,352 → measured **5,352**; 008 397 → **397**; 016 48 → **48**; 011 11 →
**8** (delta −3, the only non-reproduction).

**Verdict.** Confirmed: a local repeat is deterministic and therefore **cannot** be the stability
evidence; the protocol must compare per-row outcomes and rank bands across three deployed draws
(§6 of the brief). Next: blast radius and cost (E7).

**Cost.** 6 embedding calls, all cache hits from E2, so 0 vendor HTTP calls; $0. Wall clock
36 s.

---

## E7 — blast radius, threshold window, and cost per candidate

**Question.** Which rows move under each candidate, what does each query cost, and where is the
matcher's safety window?

**Setup.** `research/647/e7-blast-radius.py`: a threshold sweep over E4's measured similarities;
the displacement of every other candidate when one anchor is injected (measured ranks + 1); and the
cost table from measured token counts and the recorded config prices. Plus a direct corpus count
for the #646 filter's blast radius.

**Command.** `python3 research/647/e7-blast-radius.py`; the 14,940-row count is the SQL
`select metadata->>'collection', count(*) from doc_children where citation->>'sourceType'='hadith'
and metadata->>'grade' is null group by 1`.

**Result.** Threshold sweep: τ 0.60 → true 27/27, controls 4/20; 0.62 → 27/27, 3/20; 0.64 →
27/27, 2/20; **0.66 / 0.68 / 0.70 → 27/27, 0/20**; 0.72 → 26/27, 0/20; 0.76 → 23/27; 0.80 →
18/27. Clean window **τ ∈ [0.66, 0.70]**.

Displacement (one injected anchor = one slot): 011 **8 → 9**; 016 **48 → 49**; 007 5,352 → 5,353;
008 397 → 398. No top-10/top-50 membership changes.

Blast radius of #646's expansion: **14,940** ungraded sahihayn rows (7,580 Bukhari + 7,360 Muslim)
that a `grade: sahih` filter now matches; no other collection's ungraded rows change (Ibn Majah 2,
Nasai 8, Tirmidhi 35 remain ungraded, measured).

Cost per representation: HyDE **$0.000095/query** (74 prompt + 60.5 completion tokens); classifier
**$0.000048/query**; table entry ≈ **$0.000012** (1 embedding, estimate from ~60 tokens at
$0.20/MTok) + 1 SQL read; table no-match path **2,525 µs / 54 KiB** (pure Python); K widening: 0
embeddings, 0 LLM, 5× candidates; #646: 0.

**Verdict.** Confirmed: the 008 and 011 instruments are the only zero-cost recoveries; 007's table
is zero-cost per query but carries a 0.04-wide threshold window and 14,940 rows of #646 blast
radius already live; 016's cheapest lever is K. Next: none — the brief is written.

**Cost.** $0 (no vendor call); wall clock 0.15 s.
