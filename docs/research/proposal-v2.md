# Proposal: an evidence-first rewrite, and how to falsify it

This is a proposal for review, not a decision. It assumes the owner's permission to
refactor architecture, and it keeps the product boundaries that make the answer
trustworthy: answer only from retrieved text, never hide the machinery, never issue a
personal fatwa.

## The one-line thesis

The current pipeline is **retrieve-once → generate-once → check-the-address**. The
measurements say the check is measuring the wrong thing, and that the retrieval stage is
lost for two independent reasons (identity, vocabulary) that one better embedder cannot
fix. The rewrite is: **make evidence the unit of the contract, make the corpus carry the
question's vocabulary, and let the model propose addresses that a deterministic read
verifies.**

## What stays

- Dual-track embeddings (Arabic primary, translation fallback) and RRF fusion: they are
  not the bottleneck, and re-embedding into an Arabic-specific encoder would be a
  downgrade ([`retrieval-evidence.md`](retrieval-evidence.md) §2).
- Deterministic label lookup (ADR-0058), surah-scope and neighbour arms: cheap,
  deterministic, and complementary.
- Every citation must exist in retrieved text; every answer carries its trace; weak
  grades are flagged; refusals stay explicit.
- The provider seams: nothing here names a vendor.

## What changes

### 1. The contract becomes an evidence unit (§ answer-attribution.md)

`requiredCitations: string[]` becomes a set of evidence units, each with members, a
canonical member, and a text hash. The gate computes `unitRecall`, `quoteFidelity`,
`claimSupport` and a diagnostic `addressPrecision` instead of a single address recall.
Over-refusal becomes its own reported axis. This is the change that makes the gate
measure trust rather than curation taste — and it can land **before** any model or
corpus change, which is why it is Phase 0.

### 2. The corpus carries the question's vocabulary

Each row's embedded text is prefixed with its canonical address and 60–100 tokens of
chunk-specific context written in the vocabulary an Indonesian lay question would use
(what this passage teaches, its theme, its collection and book). Both tracks are
re-embedded. The evidence for this and its falsification condition are in
[`retrieval-evidence.md`](retrieval-evidence.md) §10: it is the _chunk-specific_ variant,
not the generic label already measured.

### 3. The query is rewritten before it is embedded

A cheap call restates the question in the corpus's vocabulary — the reformulation the
probe measured moving `QS. 42:11` from rank 5,352 to third of five. The rewrite is traced
as its own stage; the original question is never replaced, and both queries may be
retrieved.

### 4. Candidate addresses are hypotheses, verified by a read

A cheap call may propose addresses (`QS. 42:11`, `HR. Bukhari no. 1108`). The domain pack
parses them, a deterministic read confirms existence, and the row enters the candidate
set **ranked below fused hits** and cited only if its fetched text supports a sentence.
A proposal that does not exist is dropped and traced; a proposal that exists but does
not support the answer never becomes a citation. This is ADR-0058's mechanism generalised
from "the user wrote a label" to "a model guessed one".

Why this is not model-memory-as-evidence: the model supplies a _pointer_, the corpus
supplies the _text_, and the answer cites the text. The pointer is checkable; the text is
fetched; the trace shows both.

### 5. Quotes are bound to spans before they are cited

The generator produces each citation with an exact quoted span. A deterministic check
requires the span to be a normalized substring of the cited chunk, and the span is what
the answer shows. This turns "the model says it used this passage" into "these characters
are in this passage" and catches snippet-quoting — both cheap and monolingual.

### 6. Retrieval becomes a bounded tool loop (last, not first)

If Phases 0–3 do not close the gap, the pipeline becomes a bounded agent loop of 8–10
iterations with at most two parallel calls, where every tool call is a traced stage and
the tool set is exactly the deterministic arms plus the two searches. This is what
[Ansari](https://arxiv.org/abs/2608.20390) does in production, and the probe shows the
loop works; it is also the most expensive and least reversible change, so it goes last.

## Phases, each with a stop condition

| phase | change                                                                          | cost                   | stop / falsify                                                                      |
| ----- | ------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| **0** | evidence units, quote fidelity, gate split; re-score the current 21 rows        | days, $0               | none — this is the honest baseline; every later phase is judged on it               |
| **1** | contextual headers on the **Quran subset** (6,236 rows), V0/V1/V2 comparison    | ≈ $1–2                 | stop if V2 does not put `42:11` in the top 100 and beat V1's top-10 by ≥3 questions |
| **2** | query rewrite + address-hypothesis candidates                                   | one cheap call/query   | stop if neither moves the rank trajectory of the named rows                         |
| **3** | extend headers to hadith (36k rows)                                             | ≈ $3–6                 | stop if top-10 recall on the Golden Set does not improve                            |
| **4** | bounded tool loop behind a flag                                                 | +3–6 calls/query       | adopt only if Phases 1–3 leave a measured gap                                       |
| **5** | tier-1 checker swap test (true / parallel / wrong-address / adversarial quotes) | one forward pass/claim | if it false-accepts any wrong-address quote, it is a diagnostic, not a gate         |

## Cost envelope

Embedding 42.5k rows once at paid Gemini prices is under $2 per track; header generation
with a cheap model is a few dollars at most. The recurring cost is the query rewrite plus
the address hypothesis — two cheap calls per question. Against the current run's spend
(≈$0.50 for a 21-question QA pass), none of this is material; the risk is not cost, it is
corpus surgery without snapshots.

## Risks and mitigations

- **Corpus surgery risks the paid asset.** Contextual headers are a re-ingest: pre- and
  post-ingest snapshots with manifest verification (ADR-0038) bracket every run, and the
  old rows stay readable until the new snapshot is verified.
- **A unit map can drift and silently pass rows.** Enforce member-existence against the
  snapshot, render every accepted equivalence in the trace, and audit the map — the
  contract is only as honest as the curation behind it.
- **A model-proposed address can inject wrong evidence.** Candidates rank below fused
  hits, never replace them, and are cited only with a supporting span; the trace keeps
  the proposal and the fetch.
- **Reformulation can drift to canonical generalities.** Retain the original query's
  results in the candidate set; measure specificity, not only recall.
- **The gate can be gamed by tuning on its rows.** Freeze a held-out split by unit
  family, write traps before fixes, rotate a private slice.

## What the owner would need to decide

1. **Is the canonical address a product requirement, or is "the same report under another
   chain" acceptable if it is shown?** The contract supports either; the Golden Set
   currently implies the former.
2. **May a model propose an address?** It is a pointer verified by a deterministic read,
   but it is the one place where model memory enters the loop.
3. **Does the product want the tool loop at all**, given its latency (5–21 s in the
   probe) and the added trace surface?

## Recommendation

Do Phase 0 regardless: it is free, it makes the gate honest, and it tells us which of the
six failures are real. Then Phase 1, whose falsification condition is sharp and cheap.
Only if both leave a gap should the loop (Phase 4) be built.
