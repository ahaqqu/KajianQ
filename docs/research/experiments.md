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
