# Retrieval: what the evidence supports

This note answers one question: **what should we change so that the passage a question
needs is reachable, when the current dense pass ranks it 5,352nd of 42,511?**

## 1. The diagnosis is two failures, not one

- **Identity.** `QS. 42:11` is an address that exists only in the row's `citation`
  column. The indexed text is the verse's Arabic and Indonesian translation; neither
  contains "42:11". No embedding, sparse head or reranker can score a string that is not
  in the index. Our own full-text probe confirms the shape: the required address never
  surfaced above rank 279, and for 7 of 21 questions the question and the required
  passage share no lexeme at all.
- **Vocabulary.** The decisive measurement is ours: _quoting the verse's own
  translation_ as the query moved it to rank 21, against rank 5,352 from the natural
  question. The row is findable. It is only unfindable **from the question's
  vocabulary**. That is a representation problem, and it is the one the literature has
  an answer for.

## 2. The embedder is not the lever

Arabic topical retrieval with modern multilingual encoders is strong. On MIRACL Arabic
(nDCG@10, **reported** from the model papers): multilingual E5-large 68.7,
[BGE-M3](https://arxiv.org/abs/2402.03216) dense 71.1,
[Jina-ColBERT-v2](https://arxiv.org/abs/2408.16672) 75.3. Arabic-specific BERT
derivatives are catastrophic at retrieval unless contrastively trained — the
[ArabicMTEB](https://arxiv.org/abs/2411.01192) retrieval column puts CAMeLBERT at 9.21
and AraBERTv2 at 8.62 against mE5-small at 55.14 (**reported**). Swapping to an
"Arabic model" would be a downgrade.

Our incumbent family, Gemini Embedding, is dense-only with no sparse or multi-vector
output ([2503.07891](https://arxiv.org/abs/2503.07891)) and reports MTEB(Multilingual)
68.32. A swap to BGE-M3 or Qwen3-Embedding is a marginal-quality move, and a passage at
rank 5,352 is not a near-tie at the decision boundary: no plausible upgrade closes it.

**Consequence:** do not spend the rewrite's money on a new embedder.

## 3. Representation is the lever, and the weak variant has already been tested

Contextual Retrieval prepends 50–100 tokens of **chunk-specific** context to each chunk
before embedding, so the chunk carries the vocabulary a question would use
([Anthropic](https://www.anthropic.com/research/contextual-retrieval)). Reported gains,
top-20 retrieval failure rate: contextual embeddings 5.7% → 3.7% (−35%); with contextual
BM25 5.7% → 2.9% (−49%); with reranking 5.7% → 1.9% (−67%). Vendor-measured, not
peer-reviewed, but the mechanism matches our datum.

The same post reports that **generic document summaries gave very limited gains**. Our
chapter-label probe — a generic label prepended to the row — moved top-10 recall 9/18 →
12/18 and mean rank 18.8 → 13.4 (**measured**). That is the control condition behaving
as predicted, not a refutation. The intervention that has evidence is _chunk-specific_
context: what this passage is about, in the words a lay question would use, plus its
canonical address.

## 4. Do not bolt a topical lexical arm onto a strong dense one

The Quranic passage-retrieval ablation
([Salman et al., 2026](https://arxiv.org/abs/2606.13837)) reports that a naive BM25 +
dense fusion performed **worse** than dense alone for MAP@10, recovering only after
reranking and refinement. BGE-M3's own Arabic table tells the same story: dense 71.1,
sparse alone 23.5, dense+sparse 71.1 (**reported**). Reciprocal-rank fusion with k=60
cannot distinguish a near-random arm from an informative one; it dilutes the good one.

Our own experience agrees: the tsquery arm's best rank was 279, and fusing it cost
nothing only because it was fused weakly.

**Consequence:** a lexical channel is justified **only when scoped to what lexical
matching is good at** — identifiers: digits, collection names, proper nouns — never as a
topical second opinion.

## 5. Reranking cannot rescue recall

A reranker reorders a candidate set. At rank 5,352 the row is outside any pool we would
pay to rerank. On Quran Tafsir the measured reranker gain is +0.73 nDCG
([2506.06339](https://arxiv.org/abs/2506.06339), **reported**). Our own production
measurement agrees in the other direction: the reranker applied to 21/21 answers,
displaced required citations by +6 … −8 positions, and produced **no attributable
verdict change** (measured, deployed run).

Reranking is a cost lever — a small open cross-encoder (Qwen3-Reranker-0.6B,
[2506.05176](https://arxiv.org/abs/2506.05176), Apache-2.0) can replace an LLM decision
call — not a recall lever.

## 6. What about late interaction and learned sparse?

Late interaction is the best Arabic number in the literature (Jina-ColBERT-v2 75.3), but
its licence is CC BY-NC 4.0 — unusable here without a separate licence — and multi-vector
storage has no native `MAX_SIM` in pgvector on a single VPS. ColBERTv2's residual
compression ([2112.01488](https://arxiv.org/abs/2112.01488)) makes it storable, not
queryable at our scale without a dedicated engine. Learned sparse (SPLADE-v3,
[2403.06789](https://arxiv.org/abs/2403.06789)) has English-only evidence and is not an
identifier fix either.

**Consequence:** revisit at millions of passages on a real vector engine; not now.

## 7. Query reformulation is the cheap, high-yield runtime lever

Two bodies of work support asking the model to restate the question in the corpus's
vocabulary before retrieval: HyDE ([ACL 2023](https://aclanthology.org/2023.acl-long.99/),
DL19 44.5 → 61.3) and step-back prompting ([2310.06117](https://arxiv.org/abs/2310.06117)).
Neither has Arabic evaluation, and neither can invent an address it does not know.

Our probe supplies exactly the missing evidence for the mechanism (`agentic-probe.md`):
a tool-using model rewrote "Apa itu sifat wajib bagi Allah" into
"tidak ada sesuatu pun yang serupa dengan Dia Maha Mendengar Maha Melihat", and that
query returned `QS. 42:11` **third of five** on the first attempt — a verse the same
system ranks 5,352nd from the user's own words. Reformulation is not a better embedder;
it is a better _query_, and it is nearly free.

## 8. Ranked options for this deployment

Constraints: one VPS, Postgres + pgvector, offline ingestion, hosted APIs allowed,
42.5k passages now.

| rank | option                                                                                                                                                                | expected effect                                                                | cost                                                                           | evidence status                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Chunk-specific contextual headers** (address + what it teaches, in question vocabulary) prepended before embedding, both tracks                                     | high on the vocabulary class; makes the address lexically reachable            | one ingest pass; ~$1–3 at paid embedding prices, less if the free tier is used | mechanism measured by us (#21) and by Anthropic (−35%/−49%)                                                                                                                                    |
| 2    | **Verified address hypothesis** — a cheap call proposes addresses; a deterministic read confirms the row exists; the row enters as a _candidate_, never as a citation | high for questions that imply one specific verse (likely the direct 42:11 fix) | one cheap call/query; reuses the existing label-lookup read                    | our probe measured a model naming 42:11 and fetching exact rows                                                                                                                                |
| 3    | **Scoped lexical channel** — `unaccent` + Arabic orthography folding, queried only for digit-bearing or proper-noun tokens                                            | medium: identifiers match, topics do not dilute                                | index rebuild, no vendor cost                                                  | Postgres `simple` does no folding ([docs](https://www.postgresql.org/docs/current/textsearch-dictionaries.html)); BM25 Arabic 48.1 with a proper analyzer vs 18.9 with sub-word (**reported**) |
| 4    | **Open cross-encoder rerank** (Qwen3-Reranker-0.6B or bge-reranker-v2-m3) in place of the LLM decision rerank                                                         | low on recall, neutral-to-positive on cost/latency                             | CPU, +100–300 ms                                                               | MMTEB-R 66.36 vs 58.36 (**reported**)                                                                                                                                                          |
| 5    | HyDE / step-back as a standalone retriever                                                                                                                            | uncertain; no Arabic evidence                                                  | one generation/query                                                           | rejected as the primary lever; subsumed by 2                                                                                                                                                   |
| 6    | late interaction                                                                                                                                                      | low-moderate                                                                   | storage + engine                                                               | licence/engine blockers                                                                                                                                                                        |
| 7    | learned sparse                                                                                                                                                        | negligible on Arabic                                                           | re-ingest                                                                      | dense+sparse == dense (**reported**)                                                                                                                                                           |

## 9. What the literature does not settle

- **No benchmark exists for address-addressed retrieval over Arabic scripture.** Quran
  QA and MIRACL are topical; AR-Sanad 280K is narrator classification; IslamicTurathBench
  has no retrieval task. Our three failing rows are, as far as this review found, the
  only evidence for this failure class — which is why the proposal measures them
  directly rather than leaning on published recall.
- Whether late interaction helps **identifiers** (as opposed to topics) is unmeasured
  anywhere.
- Whether isnad-as-metadata beats whole-row text has one measurement: ours (matn-only
  was worse).
- Whether a generator reliably names the right verse is empirical, and it gates option 2.

## 10. The experiment, and what it returned

The first experiment was run on the Quran subset — three variants of the embedded text
(today's text, the generic address+surah label, and a generated chunk-specific context
line), ranked against nine questions that require a verse. Full table and caveats in
[`experiments.md`](experiments.md).

The result changed the plan:

- **The generic label is the win.** Putting the address and surah name in the embedded
  text lifted top-10 from 4/9 to 7/9 and moved three questions from rank 14–101 to 1–3.
  It is deterministic, free, and reversible.
- **The generated context line did not beat it** (7/9, worse rank on five of nine rows).
  The hypothesis that chunk-specific context closes the gap is **falsified for this
  corpus**, and the re-embed-with-headers plan is dropped.
- **Neither touches the identity class.** `QS. 42:11` never enters the top 100 in any
  variant; only reformulation found it (see [`agentic-probe.md`](agentic-probe.md)).

So the ranked options above narrow: option 1 becomes "label, do not re-embed", option 2
(the verified address hypothesis) carries the identity class alone, and option 3–7 stay
where they were.
