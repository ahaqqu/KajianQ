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
