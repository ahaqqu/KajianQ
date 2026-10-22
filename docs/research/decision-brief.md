# Decision brief — what to build, in what order, and what it buys

One page. Each claim points at the experiment that measured it (`experiments.md`) or the
document that argued it (`retrieval-evidence.md`, `answer-attribution.md`).

## The problem in one line

The product retrieves the right evidence about half the time, and nothing checks whether the
quoted text it shows is the text it retrieved. Those are two independent failures, and the
research says they need different fixes.

## What measurement has settled

1. **The embedder is not the lever.** The best Arabic-capable open model is a few points
   above the deployed one on MIRACL (71.1 vs a 60s figure), the free hosted alternatives are
   licence-barred (Jina-ColBERT-v2 is CC BY-NC), and the corpus is 42k rows where dense recall
   is dominated by vocabulary mismatch, not model quality (`retrieval-evidence.md` §2).
2. **Candidate availability is cheap.** Six query calls in three shapes put the required row
   in the top ten for 13/17 and the top fifty for 15/17, against 6/17 and 12/17 for the user's
   own wording — and the shapes fail on _different_ rows, which is why the union works
   (E6, E8–E10).
3. **Selection is the bottleneck.** A reranker over that pool lands the row in the top five
   for 7/17, and on hadith its misses are parallel narrations it has no reason to prefer
   (E7). Better ranking cannot fix a choice the corpus does not mark.
4. **Quote fidelity is deterministic and precise.** 29 cases, zero mismatches: verbatim,
   elided and Arabic-stripped quotes accepted; paraphrases and other-chunk quotes rejected
   (E3). This can gate today with no model involved.
5. **A model may not gate support.** An adversarial negation flip was accepted in 1 of 6
   cases, and address hypotheses are 61% recall at 14% fabricated (E4, E2). Existence checks
   are mandatory; model verdicts are diagnostics.

## Four decisions

### D1 — Adopt evidence units, `strict` first

A requirement becomes a unit with a canonical address and zero or more curated members; the
gate accepts the canonical always, and a member only under `equivalent`
(`answer-attribution.md` §2, implemented in `evidence-units.ts`).

**Buys:** 008 becomes winnable legitimately (`5027` is a valid sibling), and the hadith
misses from E7 stop being failures — the answer cites a parallel narration and the trace says
so. **Costs:** curation, one human signature per equivalence. **Risk if skipped:** the gate
keeps demanding one address for evidence that exists in five places.

### D2 — Make quote fidelity a gate, not a score

Every citation's quote must be a normalised substring of the retrieved chunk, with ellipsis
and Arabic diacritics handled (E3, `quote-fidelity.ts`). An answer whose quote does not check
out is not shown as evidence.

**Buys:** the product cannot claim what the source does not say — the owner's stated goal,
made mechanical. **Costs:** nothing per query; a regeneration path when a quote fails.
**Risk if skipped:** the current UI shows quotes with no mechanical link to the retrieval.

### D3 — Expand to six queries and union, behind a flag

Four topic queries, one hypothetical passage, one quotation; the user's question always runs
first (`query-expansion.ts`).

**Buys:** 13/17 top-10 against 6/17 today (E10). **Costs:** six cheap calls and one extra
embedding round-trip per query; measured candidate pools of 19–37 rows already rerank in the
current shape.

### D4 — The tool loop only for the identity class

007 is unreachable by any wording (rank 230–582 across four shapes) and reachable third of
five by iterative search with result feedback (`agentic-probe.md`).

**Buys:** the class of questions whose evidence cannot be found by restating them.
**Costs:** 5.3–20.7 s and 2–20 calls per question, measured.

## Recommendation

D2 and D1 first: they are deterministic, they need no model, and they turn the product's
central promise into a check. D3 next, because it is cheap and measured. D4 last, and only
for the identity class behind a flag, because it is the only one that changes the latency
envelope a user feels.

## If you do not rule: what I will and will not do

Silence is not a decision, so this is the default I will act on, chosen to be the least
presumptuous option that still makes progress:

- **D2 — proceed, as a measurement only.** Quote fidelity enters the eval harness as a scored
  field computed from the chunks an answer cites. It gates nothing, changes no answer, and
  gives the module the caller the Definition of Done requires. A gate would wait for your word.
- **D1 — hold.** Evidence units change what the gate accepts, which changes what the product
  promises. The three proposals stay proposals until a curator signs them.
- **D3 — hold.** Six queries per question change the cost and latency of every answer.
- **D4 — hold.** The tool loop changes the latency a user feels.
- **#638 and #639 — hold.** Both are religious-classification and product-scope rulings; the
  numbers I posted bound their consequences, they do not choose.

Anything that would merge to `main`, re-embed the corpus, or alter what a user is told to
trust waits for an explicit decision.

## What remains unbuilt until you choose

The pipeline integration of all four, the corpus-wide label prefix (E1 measured 4/9 → 7/9 on
Quran but requires re-embedding 42k rows of a paid corpus with snapshots before and after),
and the hadith-side curation of the three equivalence groups E7 identified.
