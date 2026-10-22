# Experiment log

Every entry is **measured** on the local corpus unless marked otherwise. Committed
harnesses live in `research/` so the measurement can be repeated.

## E1 — Contextual headers vs generic labels on the Quran subset (2026-10)

**Question.** Does chunk-specific context make a needed verse reachable — and does it beat
the cheaper generic label?

**Setup.** All 6,236 Quran rows, embedded with `gemini-embedding-001` (1,536 dims) on the
translation track, into a scratch database (`kq_research`); the corpus was read-only.
Three variants of the embedded text:

- **V0** today's text (the stored translation vector — what production actually uses);
- **V1** generic label: `QS. s:a (Surah NAME). <translation>`;
- **V2** contextual label: V1 plus a 1–2 sentence Indonesian context line generated from
  the verse in lay-question vocabulary (`research/contextual-header-experiment.py`,
  6,236 cheap-model calls).

Ranks are within the 6,236 Quran rows. Nine Golden Set questions require a Quran verse;
each query was embedded once and ranked against each variant.

**Result.**

| question | required |  V0 |     V1 |      V2 |
| -------- | -------- | --: | -----: | ------: |
| 001      | 2:255    |   1 |      1 |       1 |
| 002      | 2:43     |   6 |  **1** |       2 |
| 005      | 112:1    |  14 |  **2** |       3 |
| 007      | 42:11    | 498 |    644 | **342** |
| 009      | 89:28    |   1 |      1 |       1 |
| 010      | 2:275    |   1 |      1 |       1 |
| 012      | 1:1      |  93 | **22** |      80 |
| 014      | 98:5     |  23 |  **1** |       2 |
| 015      | 1:2      | 101 |  **3** |       4 |

Top-10 hits: **V0 4/9, V1 7/9, V2 7/9**.

**What it establishes.**

1. **The address and surah name in the embedded text is a large, cheap win.** V1 lifts
   top-10 from 4 to 7 and turns three questions from far misses into rank 1–3.
2. **Chunk-specific context does not beat that label on this corpus — it dilutes it.**
   V2 is worse than V1 on five of nine rows, and never wins by more than one rank. The
   Phase 1 falsification condition (V2 must beat V1's top-10 by ≥3 questions) **fired**.
3. **The identity class is untouched.** `QS. 42:11` never reaches the top 100 in any
   variant (best 342), and `QS. 1:1` stays outside the top 20. A representation change
   does not close the doctrine gap; the tool-based query reformulation measured in
   [`agentic-probe.md`](agentic-probe.md) does (it found 42:11 at third of five).

**Interpretation, honestly bounded.** V1's gains concentrate where the question names a
surah or an address (005, 014, 015) — a lexical match on the label, not a semantic
insight. The doctrine questions (007, 012) do not name anything, and gain little.

**Consequences.**

- Drop the plan to re-embed the corpus with generated contextual headers: it costs a
  corpus pass and buys nothing over a label that can be derived deterministically.
- Add the label (`address + surah/book name`) to the embedded text — cheap, no vendor
  call, reversible — and measure the hadith side for the same effect.
- Keep the identity class on the hypothesis-and-verify path, not on embeddings.

**Cost.** Embeddings ran on the free tier (no charge). Context lines: 6,236 calls to a
cheap model, ~1.9M prompt and ~0.3M completion tokens by the prompt/response lengths —
≈$0.8 at list price, **not metered** in this spike.

**Caveats.** One embedding model, one corpus language track, nine questions. Ranks are
deterministic, but the top-10 comparison at n=9 cannot separate a one-question difference
from noise; the rank trajectories of 005/014/015 are the durable part.

## E2 — Can a model name the canonical address before retrieval? (2026-10)

**Question.** The identity class needs an address that similarity cannot score. Can a cheap
call simply _name_ it, so a deterministic read can confirm it?

**Setup.** All 21 Golden Set questions, asked with no retrieval context for up to five
candidate addresses in the corpus's own forms (`QS. s:a`, `HR. collection no. N`); 18 of the
21 carry a required citation. Every proposal was then checked against the corpus for
existence (`research/address-hypothesis-probe.py`, `deepseek-chat`, temperature 0).

**Result.**

| measure                                   |        value |
| ----------------------------------------- | -----------: |
| questions with a required citation        |           18 |
| required address among the five proposals | **11 (61%)** |
| required address as the first proposal    |  **9 (50%)** |
| proposals made                            |           93 |
| proposals that exist in the corpus        | **80 (86%)** |

Per-question, the six measured failures split three ways:

- **named exactly** — 006 (`Bukhari 1108`, second proposal) and 012 (`QS. 1:1`, first).
  The hypothesis path would recover evidence that retrieval misses.
- **named a different, also-valid address** — 008 (`Bukhari 5027` instead of 5026; both are
  about the merit of the Quran). This is the contract problem again, not a model error.
- **not named** — 007 (`QS. 42:11` absent; the model offered 2:255, 112:1, 59:22), 016
  (`Bukhari 8` rather than 1395), 017 (unrelated rulings).

**What it establishes.**

1. A model can carry a large share of the identity class — but **not all of it**: 7 of 18
   required addresses were never proposed, and half the questions miss the first guess.
   The address hypothesis therefore complements query reformulation (which found 42:11 via
   search) rather than replacing it.
2. **Verification is mandatory, not ceremonial**: 13 of 93 proposals (14%) do not exist in
   the corpus. Without the deterministic read they would enter the candidate set as
   fabricated evidence — exactly the failure the product must never ship.

**Caveats.** One model, one prompt, one draw at temperature 0 per question; a second model
or a few samples could raise recall. The hit rate is measured against the _curator's_ choice,
so a "miss" can mean a defensible alternative address, as 008 shows.

## E3 — The deterministic quote-fidelity check (2026-10)

**Question.** Can a citation be verified without a model — "these characters are in the
passage you cited" rather than "the model says it used it"?

**Setup.** Six real rows (three hadith, three verses) and five kinds of quoted span:
verbatim, elided with an ellipsis, Arabic with diacritics stripped, a paraphrase (the
words reversed), and a span lifted from a **different** chunk. Normalisation folds
diacritics, alef/ya/ta-marbuta variants, punctuation and case
(`research/quote-fidelity-check.py`).

**Result.** 29 cases, **0 mismatches**.

| case                            | accepted |
| ------------------------------- | -------- |
| verbatim                        | 6/6      |
| elided (`…` between fragments)  | 6/6      |
| Arabic with diacritics stripped | 5/5      |
| paraphrase                      | **0/6**  |
| quote from another chunk        | **0/6**  |

**The bug the first run caught.** Normalising before splitting on the ellipsis erases the
ellipsis and turns an elided quote into one contiguous string no chunk contains — five of
six legitimate elided quotes were falsely rejected. The fix is ordering: split the raw
quote on `…`, normalise the fragments, then require each fragment in order. Any
implementation of this check must be tested with an elided quote, or it will fail honest
answers.

**What it does not do.** It cannot catch a minimal adversarial edit (a negation, a
changed number, a swapped name) — the words are still in the passage. That class belongs
to the model tier and is what the swap test in [`answer-attribution.md`](answer-attribution.md)
§7 measures. The two tiers are complementary: this one has no false accepts on the
"wrong chunk" and "paraphrase" classes and costs nothing.

## E4 — The swap test: may a model checker hold a gate seat? (2026-10)

**Question.** [`answer-attribution.md`](answer-attribution.md) §7 sets the rule: if a cheap
model checker accepts a wrong-address or a minimally-edited quote, it cannot gate claim
support. This is the measurement.

**Setup.** Six claims, each with four quotes, all drawn from real corpus rows
(`research/evidence-swap-test.py`, `deepseek-chat`, temperature 0):

- **true** — a window around the claim's keyword inside the cited row;
- **parallel** — a window from the same report under another chain or an adjacent verse;
- **wrong-address** — a window from a passage on another topic;
- **adversarial** — the true quote with one meaning-flipping edit, applied only where the
  edit provably changes the text (a negated verb, a swapped _haram/halal_, `Tidak ada` → `Ada`).

**The first run was invalid and is worth recording.** Its quotes started at the isnad and
never reached the matn, so the "true" condition was accepted only 2 of 6 times — the matrix
measured my construction, not the checker. A swap test must assert that each _true_ quote
actually supports its claim, and that each adversarial edit actually changed the text.

**Result** (corrected construction): 24 checks.

| condition     | accepted | wanted |
| ------------- | -------: | ------ |
| true          |  **6/6** | accept |
| parallel      |      5/6 | accept |
| wrong-address |  **0/6** | reject |
| adversarial   |  **1/6** | reject |

**Decision.** The rule fires: the checker false-accepted one adversarial quote — `Tidak ada
sesuatu pun yang serupa dengan-Nya` edited to `Ada sesuatu pun yang serupa dengan-Nya`,
judged as supporting _"Allah tidak menyerupai makhluk-Nya"_. A negation flip is the classic
weakness, and one false accept is enough. **The model checker does not gate claim support;
it is a diagnostic.** The gate rests on `quoteFidelity` plus curated units, exactly as the
contract anticipated.

**What it is nevertheless good for.** It rejected every wrong-address quote (6/6) and
accepted every genuine one — a useful _alert_ for answers whose support is doubtful, and a
plausible acceptance test for parallel evidence (5/6; the single rejection is a quote that
genuinely does not state the claimed reward, so the checker was right). It must never be
the thing that lets an answer through.

**Caveats.** One model, one prompt, six claims, one draw each. The negation class is known
hard for English checkers and has no Arabic/Indonesian evaluation; the single failure here
is consistent with the ~80% attribution ceiling reported for fine-tuned models.

E3's logic is implemented in TypeScript as [`research/quote-fidelity.ts`](../../research/quote-fidelity.ts),
with the positive and negative cases as tests (`bun test research/quote-fidelity.test.ts`):
verbatim, elided and diacritics-stripped quotes are faithful; a paraphrase, a span from
another chunk, and an empty quote are not. It is a research artefact — the integration into
the eval gate belongs to the Phase 0 change.

## E5 — One rewrite call: does it beat the user's own wording? (2026-10)

**Setup.** Seventeen questions with a required citation; one `deepseek-chat` call rewrites
each question into a single short search query in corpus vocabulary; the rewritten query is
embedded and the rank of the required row is measured over its own source type
(`research/query-rewrite-probe.py`).

**Result.** A wash at the aggregate, and erratic per row: top-10 **6/17 before, 7/17
after**; top-50 12/17 before, 11/17 after. It helped 007 (498 → 338), 011 (11 → 4), 012
(93 → 46), 014 (23 → 2), 017 (22 → 19); it hurt 013 (12 → **1375**), 016 (32 → 171), 006
(10 → 24), 008 (176 → 256), 015 (101 → 119).

**Reading.** A single rewrite is a lottery: the model sometimes lands on the passage's own
vocabulary and sometimes drifts to a topical paraphrase that ranks far worse. That is
consistent with the literature's coverage/correctness trade-off, and it means one rewrite
call is not a deployable fix on its own.

## E6 — Four rewrites and the union: the oracle bound (2026-10)

**Setup.** Same seventeen questions; one call returns four deliberately different queries
(classical terms, plain Indonesian, likely subject, a quotable phrase); each is embedded and
ranked independently (`research/multi-query-probe.py`). Reported is the best rank any of the
four achieves — the bound for a retriever that unions the four candidate lists and reranks
them.

**Result.** Top-10 **12/17**, top-50 12/17 — against 6/17 for the user's wording and 7/17
for a single rewrite. The spread per question is enormous: 013 ranges over ranks 8, 17, 45,
78; 007 stays at 230–463; 021 never moves below 22,510 in any wording.

**What it establishes.**

1. **Query diversity, not query cleverness, is the lever.** Four differently-worded queries
   put the required row inside some query's top 10 for twelve questions, where one rewrite
   could do it for seven. The cost is four rewrites plus four embeddings per question —
   cents — and the candidate union is what a reranker would then have to order.
2. **The bound is not a result.** Twelve of seventeen is what a _perfect_ chooser among four
   candidate lists would get. Realising it needs a reranker that prefers the right candidate,
   and the existing LLM decider has never been measured on this candidate shape.
3. **Some rows stay out of reach.** 007 (230–463) and 021 (22,510+) are not found by any
   wording — evidence that a vocabulary lever alone does not close the identity class, which
   is what the tool loop and the verified address hypothesis exist to cover.

## E7 — Does the reranker realise the union's reach? (2026-10)

**Setup.** For each of the 17 questions: retrieve the top 10 for the user's query and the top
10 for each of E6's four rewrites; union and dedupe (19–37 candidates); ask the same class of
reranker the product uses to order them; the required row is a hit when it lands in the top
five (`research/union-rerank-probe.py`).

**Result.**

|                                         | user's query | four-query union |
| --------------------------------------- | -----------: | ---------------: |
| required row in the candidate pool      |        11/17 |        **12/17** |
| required row in the reranker's top five |     **3/17** |         **7/17** |

**The first two runs measured the harness, not the system.** The reranker sometimes answers
with indices (`["0","1","4"]`) and sometimes with address strings, and the parser only
accepted addresses — so real hits were scored as misses (1/17 and 3/17 before the fix, 7/17
after). A candidate-ranking probe must accept both answer shapes, or it understates the
system it is measuring.

**What it establishes.**

1. **The union roughly doubles candidate reach and the reranker converts about half of it.**
   Top-five 3 → 7, with the gains concentrated on Quran rows (002, 005, 010, 012, 014 all
   move into the top five) and one regression (003 fell out).
2. **On hadith the remaining misses are mostly address choice, not retrieval.** For 006 and
   017 the required row _is in the pool_ and the reranker prefers another narration — for
   006, `Nasai 598`, the same report under another chain. No reranker can prefer the
   curator's canonical choice, because nothing in the corpus marks it. That is the evidence
   unit's job, not the reranker's.
3. **The oracle is not reached.** Twelve rows are reachable in the pool; seven are selected.
   A better reranker might close part of the gap, but the hadith pattern above says the
   ceiling is set by the contract, not by ranking quality.

**Caveats.** One reranker model and prompt, excerpts capped at 400 characters centred on the
matn, n=17. The excerpt cap alone could explain part of the gap, and the union may be hurt
by pool size (the smallest pool, 003's, is the one that regressed).

## E8 — Hypothetical passage (HyDE): a different shape, a different reach (2026-10)

**Setup.** One call per question writes "the passage that would answer this", in the voice of
a Quran or hadith translation, with no address; the passage itself is embedded and ranked
(`research/hyde-probe.py`).

**Result.** Top-10 **10/17**, top-50 **14/17** — against 6/17 and 12/17 for the user's wording,
and 12/17 / 12/17 for E6's four topic rewrites. The profile is different rather than better:
it cracks rows no wording reached, 006 (rank 10 → **1**), 021 (27,587 → **41**), 011 (11 → **1**),
015 (101 → 36); and it loses 007 (230 → 582) and 008 (144 → 751).

## E9 — Quote-shaped passage: the verse's own words, without its address (2026-10)

**Setup.** One call per question writes the literal Indonesian rendering of the verse or
hadith it believes answers the question — text only, never an address — and that text is the
query (`research/quote-hyde-probe.py`).

**Result.** Top-10 9/17, top-50 12/17, with the same wide spread: 006 falls to rank 96 and
013 to 1,024, while **007 lands at rank 23** — the only query shape that reaches it, and the
counterpart of E2, where the model could not name `QS. 42:11` but can supply its words.

## E10 — The union of three query shapes (2026-10)

| candidate set                 |    top-10 |    top-50 |
| ----------------------------- | --------: | --------: |
| the user's wording            |      6/17 |     12/17 |
| four topic rewrites (E6)      |     12/17 |     12/17 |
| hypothetical passage (E8)     |     10/17 |     14/17 |
| quoted passage (E9)           |      9/17 |     12/17 |
| **all three shapes together** | **13/17** | **15/17** |

The three shapes fail on different rows, which is the whole point: 007 is reachable only by
quoting the passage, 006 and 021 only by the hypothetical passage, 015 best by the quoted
one. Six cheap calls per question turn 6/17 into 13/17 top-10 and 15/17 top-50.

**What remains outside every shape:** 008 (best rank 144 — and its sibling `5027` is an
equally valid answer, so this is a contract failure, not a reach failure) and 016 (best 61,
just outside the cut). Nothing on the query side reaches them, and 016 is the row the
address hypothesis also missed.

**Caveat that keeps this honest.** Fifteen of seventeen at top-50 is _candidate availability_,
not answers. E7 measured that a reranker converts about half of such a pool, and the
conversion is where a product is lost or won.

E10's mechanism is implemented as [`research/query-expansion.ts`](../../research/query-expansion.ts):
`queriesFor` fixes the deterministic query order with the user's question first, and
`unionCandidates` unions by row id while keeping the shape that surfaced each row first, so
the trace can show which query produced a hit. Tests run with
`bun test research/query-expansion.test.ts`. It is a research artefact, not a pipeline stage.

## E11 — Given the evidence, does the answer quote it honestly? (2026-10)

**Setup.** Nine questions, each answered over five passages: the required row plus four
near neighbours (the gold passaged ranked first in the prompt, the distractors chosen by
embedding similarity, and the addresses shown as `neighbour-n` so the model cannot simply
repeat the gold address). The instruction is product-shaped: answer in Indonesian, quote a
short phrase per claim, cite `[n]`, add nothing from outside. The quotations are then checked
by the deterministic checker in `research/quote-fidelity.ts`
(`research/answer-generation-probe.py`, `research/answer-fidelity-report.ts`).

**Result.** 27 quoted spans across nine answers: **26 faithful to the passage they point at,
1 unattributed (words present, no marker), 0 misattributed, 0 fabricated.** Every answer used
the gold passage at least once, and none named an address that was not in its context.

**The first report said four quotes were fabricated, and that was wrong.** The quote
extractor paired a _closing_ straight quote with the next _opening_ one, so it sliced
`…" [2] dan "…` into a span no passage can contain. Typographic quotes are unambiguous and are
now taken first; the remaining straight quotes are split by parity, and spans under eight
characters are skipped as emphasis or quoted terms rather than checked. Four tests pin the
behaviour, including the adjacent-quote case. A gate that invents failures is as damaging as
one that misses them, and this one would have refused honest answers.

**Behaviour worth more than the number.** Two of the nine refused: `gs-v0-012` said the source
does not explain the meanings of _ar-Rahman_ and _ar-Rahim_ (the required row is `QS. 1:1`,
which merely names them), and `gs-v0-017` said the sources do not state the ruling on praying
in gold — while the required passage does say gold is _haram_ for men. Both refusals are
textually defensible and require a one-step inference to answer. The Golden Set counts both as
failures, so this is a **calibration** problem — the system is punished for a correct refusal
and rewarded for an inference it was not asked to make explicit.

**Consequence for the gate.** Fidelity alone would pass an empty answer: it checks that
whatever is quoted is real, not that the requirement was covered. A gate therefore needs both
`quoteFidelity` and `unitRecall`, which is the split `answer-attribution.md` describes.

**Caveat.** Passages were capped at 700 characters, which truncated the two longest hadith
rows (1,034 and 772 characters); both still answered and cited. The other seven were complete.
