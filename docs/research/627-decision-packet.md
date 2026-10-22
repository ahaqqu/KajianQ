# Decision packet — #627: what each instrument change recovers, risks and costs

Status: research decision brief. Evidence ids cite [`627-experiments.md`](627-experiments.md);
every claim is labelled **measured** (a harness or corpus read I ran) or **reported** (a QA report
whose traces were erased, or a prior measurement I did not re-run).

## The claim, and whether it survived

The packet tested two claims:

> **C1.** The five proposed instrument changes recover only the Golden Set rows they target, take
> the set from 15/21 to 20/21, and never flip a passing row or accept a citation that is neither
> the required address nor a stated equivalent.
>
> **C2.** `gs-v0-016`'s address half needs an owner decision about what address recall measures,
> and `gs-v0-007` cannot be measured locally by retrieval alone — the concept that selects the
> verse is absent from the corpus.

**Verdict.** C1 is **confirmed for recovery and blast radius**, with one correction that matters:
the recorded cause for 006 ("same report") is **refuted at head** — `Bukhari 1108` and
`Nasai 598` are the same ruling under different chains, not the same report (E1). The change
still recovers the row, but it buys that by changing what the requirement means, not by
recognising an identical report. C2 is **confirmed**: 016 needs both an identity map and a metric
change, and 007 has no retrieval-side fix (E6).

**What would refute it.** A fresh deployed run whose cited labels differ from the recorded draw
(the fused set is unstable run to run, reported #376 `6331117608`); or a held-out question where a
new identity group accepts a citation of a different report and the answer is wrong for reasons
the row cannot see; or a query representation that reaches `QS. 42:11` without containing the
verse's text. None of these was observed, but only the first two are testable with a run.

## What settled it

| stream                     | what it is                                                                                                                        | used for                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **measured** E1            | read-only SQL over `doc_children` (42,511 rows): address presence, chains, 5-gram matn overlap, 6,236 Qur'an addresses            | the recorded causes, corpus-wide blast radius                          |
| **measured** E2–E5         | the real `citationValidity` / `citationAddressRecall`, the real grammar and identity parser, on the recorded cited/retrieved sets | recovery and blast radius of D1–D4                                     |
| **measured** E6            | exact cosine rank over the corpus's own stored `embedding_primary` (gemini-embedding-001, 1536) for 9 query texts                 | 007's reachability, 016's residual                                     |
| **measured** E8            | the repo's recorded-run replay test (7/7)                                                                                         | proves the harness scores a known case before its numbers are believed |
| **reported**               | the cited labels and fused sets of runs `5d47c85b`, `6888d711`, `42101c2c` (traces erased)                                        | the _inputs_ to E2–E5; their scoring is measured                       |
| **not measurable locally** | a fresh production run under any change; the generator's citation choice; generalisation to questions outside the Golden Set      | marked as owner calls, no invented numbers                             |

## The six rows, measured

| row              | cause verified at head                                                                                                                                                     | change               | recovery (measured)                                                                                                            | blast radius                                                                                                                                              | cost                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **006**          | `Bukhari 1108` (Anas chain) vs cited `Nasai 598` (Ibn Umar/Nafi' chain): 5-gram overlap **0.000** → **same ruling, different report** (E1). Address retrieved (recall 1.0) | D1 identity group    | validity **0 → 1** in both recorded draws (E2). Passes **if** the owner rules the requirement is the ruling                    | +1 label into an existing group; **+5 of the 36 new pairs**; no other row moves; no pass→fail possible                                                    | data only, owner signature, reversible                                                           |
| **012**          | `QS. 1:1` contains `QS. 1:3` exactly; both name ar-Rahman + ar-Rahim (E1). Address retrieved (1.0)                                                                         | D2 verse equivalence | validity **0 → 1** under a curated pair; controls unchanged (E3)                                                               | curated pair = **1 pair**; naive "both names" rule would add ≤15 pairs across **6** verses (2:163 etc. are not the basmalah)                              | new domain fixture + loader; no re-embed; reversible                                             |
| **016 citation** | `Bukhari 1395` ≡ `Abu Dawud 1584`: identical chain, 5-gram overlap **0.25** (the matn) → **same report** (E1). Cited 1584, required 1395                                   | D1 identity group    | validity **0 → 1** (E2)                                                                                                        | +5 labels / +10 pairs; **no other row**                                                                                                                   | data only, owner signature                                                                       |
| **008**          | `5026` vs cited `5027/5028/4937`: overlap 0.009 / 0.000 / 0.010 → **different narrations**, each a valid virtue hadith (E1)                                                | D3 answer set        | validity **0 → 1** _and_ address recall **0 → 1** for set `{5026, 5027, 4937}` in both draws (E4)                              | **1 row**; no other fixture row has >1 requirement (18 requirements / 21 rows), so a global AND→OR change is inert today                                  | contract + scorer change, curated set; no re-embed                                               |
| **016 address**  | required row never in the fused set (reported); local verbatim rank **#48 / 42,511** (reported #61) (E6)                                                                   | D4 address policy    | identity-satisfied address recall **0 → 1**, so 016 passes **only with D1** (E5)                                               | **1 row today**; but any of the **42 labels in 6 groups** becomes address-satisfying for a member's requirement; the metric stops measuring exact address | scorer/SPECS decision; breaks comparability with 0.857 at `3d07155`                              |
| **007**          | `QS. 42:11` exists (189 chars) but the verbatim question ranks it **#5352** (within surah #18); concept expansion **#56**; only the verse's own text reaches **#1** (E6)   | D5 concept lever     | **not measurable locally**: the anchor would be retrieved by construction; whether the generator cites it needs a deployed run | unknown until a concept table exists; cannot be a per-question trigger (the only #1 query contains the answer)                                            | new domain module + curated concept→anchor table + ADR; no re-embed, no corpus write; reversible |

`gs-v0-017` (not among the six named in the dispatch but in D1's memo): required `Nasai 5144` vs
cited `Ibn Majah 3597` — different companions, 5-gram overlap 0.011, same instruction (E1). The
identity group flips validity 0 → 1 (E2), but the required row itself does not mention prayer, so
the row can pass while the answer still does not answer its question. That is a fixture-ambiguity
decision, not a retrieval one.

## The arithmetic

| state (cumulative)    | pass                  | condition                                           |
| --------------------- | --------------------- | --------------------------------------------------- |
| recorded at `3d07155` | **15 / 21**           | reported                                            |
| + D2 (012)            | 16 / 21               | curated pair                                        |
| + D3 (008)            | 17 / 21               | curated set                                         |
| + D1 (006, 017)       | 19 / 21               | only under the requirement-scope ruling             |
| + D1's 016 group + D4 | **20 / 21**           | D4 is a metric change, owner call                   |
| + D5 (007)            | 21 / 21 _conditional_ | bridge must be built and cited in N≥3 deployed runs |

016 is the only row that needs **two** changes; 006, 017, 008 and 012 each need one; 007 needs new
engineering. The memo's "D1, D2, D3, D4 close five of six" is confirmed on the instrument's
verdicts — but two of D1's three groups rest on a ruling about what the Golden Set requires, and
016's pass is bought by a change to the metric.

## Decisions

### D1 — identity groups for 006 / 016 / 017 — **recommend: split the ruling; sign 016, rule on 006/017**

**Evidence.** E1: 016's pair is the same report and the same chain; 006's and 017's parallels share
only the ruling/instruction. E2: the three groups flip exactly 006/016/017 validity and no other
row; +13 labels, +36 pairs, no pass→fail.

**Why it matters.** Signing 006/017 as "same report" would write a false fact into owner-signed gate
data. Their honest form is "same ruling" — which is a decision about what the fixture requires,
not about corpus identity.

**Recommendation.** Sign the 016 group now (`Bukhari 1395` ≡ `Abu Dawud 1584`, plus the three
members the audit named if the owner accepts them). Put 006/017 as a separate ruling: _is the
requirement the ruling/instruction rather than the narration?_ If yes, sign those groups with the
relation recorded as "same ruling", not "same report".

**Default if nobody rules.** The map ships unchanged; 006, 016 and 017 stay red, and 15/21 stands.

**What would change the answer.** The owner's ruling on requirement scope; or a held-out question
that cites a parallel under the same ruling (would support the broader relation); or a wrong
answer accepted by a same-ruling group (would refute the broader relation).

### D2 — `QS. 1:1` vs `QS. 1:3` — **recommend: a curated pair, with a stated rule**

**Evidence.** E1: 1:1 contains 1:3 exactly; six verses share both names, so "same names" is not
equivalence. E3: the curated pair flips 012 only; controls unmoved.

**Why it matters.** The ruling decides what the product promises: "the verse that names the two
names" (1:3 is literally the pair) vs "the basmalah verse" (1:1). It cannot be derived by the
checker, which is why it needs a signature.

**Recommendation.** Add an owner-signed pair `{1:1, 1:3}` with the rule _"for a question about the
meaning of a divine name, a verse that names the asked-for names and adds only the basmalah is the
same evidence."_ Keep the rule to that pair; do not generalise it to verses that merely contain
the names.

**Default if nobody rules.** No Qur'an identity is wired; 012 stays red.

**What would change the answer.** A ruling that the answer owes the basmalah verse for a
name-meaning question, or a tafsir passage as the preferred evidence (then the fixture requirement
moves instead of the map).

### D3 — `gs-v0-008`'s requirement — **recommend: an opt-in answer set of equivalent narrations**

**Evidence.** E1: 5027/5028/4937 are different narrations, each a valid virtue hadith. E4: the set
`{5026, 5027, 4937}` passes both gates in both recorded draws; no other row has >1 requirement, so
the contract change is inert elsewhere.

**Why it matters.** The fixture encodes one curator's choice where the corpus offers several valid
answers. Accepting the set must be visible (a set, not a loosened substring) and must not leak into
rows that need an exact address.

**Recommendation.** Add an opt-in "any of" requirement field to the contract and scorer, and curate
008's set. The set is the curator's to name; `{5026, 5027, 4937}` is the measured candidate.

**Default if nobody rules.** 008 stays red; the contract is unchanged.

**What would change the answer.** A curator who rules 5027/4937 are _not_ valid answers (then the
row is a retrieval miss again); or a retrieval change that puts 5026 in the fused set (local rank
#397, so unlikely soon).

### D4 — address recall for 016 — **recommend: report two numbers, keep the gate exact**

**Evidence.** E5: identity-satisfied address recall flips only 016 today, but would make all 42
grouped labels address-satisfying; E6: the required 1395 is rank #48 locally and absent from the
fused set, while its same-matn twin 1584 is retrievable (#1 when quoted). E2: D1 alone leaves 016's
address at 0.

**Why it matters.** `citationAddressRecall` exists to measure whether the _required address_ was
retrieved. Making identity satisfy it turns a retrieval metric into a citation metric and makes
every historical 0.857/0.810 number incomparable. The owner's own acceptance rule for #515 allows
the residual to be recorded with a number instead.

**Recommendation.** Keep the gate exact. Add the identity-satisfied number as a reported (not
gating) dimension so the 016 residual is visible. If the owner wants 016 green, make the ruling
explicit and record it as an instrument change with its reason — the measurement says it flips
exactly one row.

**Default if nobody rules.** Gate stays exact; 016 stays red; the brief records it as residual
#016-address (D1 gives validity 1, address 0).

**What would change the answer.** A retrieval representation that puts 1395 or 1584 in the fused
top-10 on three deployed runs — then no metric change is needed.

### D5 — the 007 lever — **recommend: hold; scope a separate aqidah concept ticket**

**Evidence.** E6: verbatim #5352, best general expansion #56, only the verse's own text #1; E1:
the corpus states neither "sifat wajib" nor the tanzih concept. `QS. 42:11` is reachable only by
knowing the passage. A per-question address trigger would pass the row and teach nothing.

**Why it matters.** This is the only row that needs new engineering, and the cheap version of it
(model names the address) is model memory standing in for evidence — the thing the grounding rule
exists to prevent.

**Recommendation.** Do not attach the fix to this packet. Scope a domain concept→anchor table
(the smallest honest form: ~25 concepts / 30–45 anchors for the aqidah class) behind a flag, with
a held-out aqidah set as its acceptance test, and refuse the router-names-the-address shortcut.

**Default if nobody rules.** 007 stays red; no retrieval or concept work is funded; 20/21 is the
packet's ceiling.

**What would change the answer.** A held-out aqidah set where a curated table lifts more than the
Golden Set row alone; or an owner ruling that a quotation-shaped query (rank #1) is acceptable
despite containing the answer text — I recommend refusing it.

## What I could not settle

- **Any fresh run under a change.** The traces of the six rows' runs were erased; the cited sets
  are quoted. The scorer decisions are measured, the cited content is not.
- **The generator's behaviour after a change.** Whether a newly retrieved 42:11 or 1395 is cited
  needs N≥3 deployed runs; a single run is a draw (#627 acceptance).
- **Generalisation.** No held-out set exists; every number here is on the 21-row fixture, and the
  only instrument that could show "the instrument got easier" is a held-out set this work never
  touched.
- **The concept table's coverage/price.** Unmeasured until a table exists; the prior scope note's
  25-concept estimate is reported, not measured.
- **017's fixture ambiguity** (required row does not mention prayer) — out of the six-row scope,
  but it blocks a clean "017 passes" claim.

## Spend

10 query embeddings against the same model as the corpus; vendor `usage` was absent, estimated
**< $0.00005** at $0.20/MTok. No paid model call, no re-embed, no ingest. Total wall clock ~65
minutes of the 90-minute budget. Corpus unchanged (read-only transactions only).
