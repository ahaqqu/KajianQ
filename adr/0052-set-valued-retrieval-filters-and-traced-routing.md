# ADR-0052: Retrieval filters are set-valued behind one exhaustive map, and source routing covers every part the route decomposed

## Decision

The router's third stage selects the sources a question is answered from, and the metadata filters retrieval runs with, by **rules over the router's reading** — never a second model call — and records the decision as typed trace content. Which sources may answer a question is a published product decision, not a cheap model's.

**Route-wide coverage.** The selection is the **union** of what the route's category implies and what **every sub-query's own role** implies, derived from the sub-queries retrieval actually fans out over:

| reading or part                                           | sources selected            |
| --------------------------------------------------------- | --------------------------- |
| `category: quran` or `tafsir`                             | `quran`, `tafsir`, `hadith` |
| `category: hadith`                                        | `hadith`                    |
| `category: fikih`                                         | `quran`, `hadith`, `kitab`  |
| a `dalil` or `sanad` part                                 | `hadith`                    |
| a `principle` part, `intent: analogy`, a needed principle | `principle`                 |
| a `factual` part                                          | nothing of its own          |
| no subject area settled                                   | none — every source         |

The two scriptural areas share **one** breadth, because a question about the Quran is answered from the Quran, its commentary, and the Sunnah that carries the practice the question asks about; which of the two the reading settles is a distinction the evidence does not draw. **A category is a sample, so no row may decide whether the Sunnah is in reach:** every non-empty selection names it.

Both maps are exhaustive records over the vocabulary that owns them, so a category or role added without a decision here is a typecheck failure, and a role the mapping cannot express fails the run that must turn it into a filter. An empty category selection stays empty: a role or a lens may widen a selection, never turn "every source" into a filter. Every dimension is a **set** behind one exhaustive map.

The **authority order** — Quran, then hadith by grade, then tafsir, then kitab — is the generator's system prompt; the **presentation order** is the assembler's, deliberately distinct, with principles first and unnamed sources last.

## Why

A route that decides one thing and a search that does another is this stage's silent failure: the dimension-to-store mapping was a chain of independent conditions, so a dimension it did not know reached retrieval as no constraint at all, and nothing noticed. A category is the route's reading of what the question is about, so it cannot speak for a part the decomposition sent after another source; only the coverage rule compares the two. An empty selection stays empty in reverse: an unfiltered search already covers every part, and a union over roles alone would drop the part the category is about.

The category is also the one input this stage does not own. A rule that depends on it is not an invariant but a coin flip: a row narrower than the scriptural evidence a question needs makes the answer — and the recall a gate scores — depend on which area a cheap model named. A question that names a surah or a verse is not exposed to that, because ADR-0045 reads the reference and supplies the Quran leg whatever the filter is; the exposure is every question that names none, and there the omission is silent, because no fused track can reach a source the filter excluded. One shared scriptural breadth costs no extra call and no extra query; the fused limit and the ranking still decide what reaches the context, and a reading that settles nothing still searches everything.

Rejected: a second routing call; replacing the model's subject reading with a deterministic classifier, which swaps a sampled label for a permanent one and loses the reading decomposition also depends on; widening the scope on a source the question merely names, which duplicates the reference read ADR-0045 already guarantees and would push the Quran into hadith questions the Sunnah alone answers; selecting every source for every question, which buys stability by diluting precision; mapping an unexpressible dimension to "no constraint"; assembling evidence in authority order, which loses the lens its place as the frame.

## Consequences

- The store seam keeps taking opaque filter records; it alone binds a metadata filter in SQL.
- The routing block on the frame is additive: a frame omits a block it does not have, and persisted frames stay readable.
- The rules change by editing one table: vocabulary, role map, filter map and presentation order each read one list.
- The scriptural areas are one breadth, not every area: only a question that names no surah or verse is covered by its row alone, so a Quran question the reading calls `hadith` — or one whose only part the route could call `factual` — reaches just that row's sources, while a named reference still pulls its surah's children in whatever the filter is.
