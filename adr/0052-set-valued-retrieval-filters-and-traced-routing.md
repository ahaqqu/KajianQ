# ADR-0052: Retrieval filters are set-valued behind one exhaustive map, and source routing covers every part the route decomposed

## Decision

The router's third stage selects the sources a question is answered from, and the metadata filters retrieval runs with, by **rules over the router's reading** — never a second model call — and records the decision as typed trace content. Which sources may answer a question is a published product decision, not a cheap model's.

**Route-wide coverage.** The selection is the **union** of what the route's category implies and what **every sub-query's own role** implies, derived from the sub-queries retrieval actually fans out over:

| reading or part                                           | sources selected            |
| --------------------------------------------------------- | --------------------------- |
| `category: quran` / `hadith`                              | `quran` / `hadith`          |
| `category: tafsir`                                        | `quran`, `tafsir`, `hadith` |
| `category: fikih`                                         | `quran`, `hadith`, `kitab`  |
| a `dalil` or `sanad` part                                 | `hadith`                    |
| a `principle` part, `intent: analogy`, a needed principle | `principle`                 |
| a `factual` part                                          | nothing of its own          |
| no subject area settled                                   | none — every source         |

Both maps are exhaustive records over the vocabulary that owns them, so a category or role added without a decision here is a typecheck failure, and a role the mapping cannot express fails the run that must turn it into a filter. An empty category selection stays empty: a role or a lens may widen a selection, never turn "every source" into a filter. Every dimension is a **set** behind one exhaustive map.

The **authority order** — Quran, then hadith by grade, then tafsir, then kitab — is the generator's system prompt; the **presentation order** is the assembler's, deliberately distinct, with principles first and unnamed sources last.

## Why

A route that decides one thing and a search that does another is this stage's silent failure: the dimension-to-store mapping was a chain of independent conditions, so a dimension it did not know reached retrieval as no constraint at all, and nothing noticed. A category is the route's reading of what the question is about, so it cannot speak for a part the decomposition sent after another source; only the coverage rule compares the two. An empty selection stays empty in reverse: an unfiltered search already covers every part, and a union over roles alone would drop the part the category is about.

Rejected: a second routing call; mapping an unexpressible dimension to "no constraint"; assembling evidence in authority order, which loses the lens its place as the frame; a coverage floor.

## Consequences

- The store seam keeps taking opaque filter records; it alone binds a metadata filter in SQL.
- The routing block on the frame is additive: a frame omits a block it does not have, and persisted frames stay readable.
- The rules change by editing one table: vocabulary, role map, filter map and presentation order each read one list.
- Coverage is still not total — a category row narrower than the authority order plus a part the route could only call `factual`, or a model label dropped before the union, is covered by the category row alone.
