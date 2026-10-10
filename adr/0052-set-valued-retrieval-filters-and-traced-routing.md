# ADR-0052: Retrieval filters are set-valued behind one exhaustive map, and source routing covers every part the route decomposed

## Decision

Smart Router stage 3 selects the sources a question is answered from, and the metadata filters
retrieval runs with, by **rules over the router's reading** — never a second model call — and
records the decision as typed trace content: which sources may answer a question is a published
product decision (`SPECS.md` §2.2, the usul authority order), not a cheap model's.

**Route-wide coverage.** The selection is the **union** of what the route's Query category
implies and what **every Sub-query's own role** implies, derived from the Sub-queries retrieval
actually fans out over:

| reading / part                                            | sources selected            |
| --------------------------------------------------------- | --------------------------- |
| `category: quran` / `hadith`                              | `quran` / `hadith`          |
| `category: tafsir`                                        | `quran`, `tafsir`, `hadith` |
| `category: fikih`                                         | `quran`, `hadith`, `kitab`  |
| a `dalil` or `sanad` part                                 | `hadith`                    |
| a `principle` part, `intent: analogy`, a needed Principle | `principle`                 |
| a `factual` part                                          | nothing of its own          |
| no subject area settled                                   | none — every source         |

Both maps are exhaustive `Record`s over the vocabulary that owns them: a category or role added
without a decision here is a typecheck failure, and a role the mapping cannot express fails a
**direct caller's** run where it must become a filter — never the router's, whose stage 2 drops
a label outside the vocabulary before the union reads it. An empty category selection stays
empty: a role or a lens may widen a selection, never turn "every source" into a filter.

Every dimension is a **set** behind one exhaustive map; an unexpressible one fails the run.

The **authority order** (Quran → Hadith (mutawir > sahih > hasan; dhaif flagged) → Tafsir →
Kitab) is the Generator's system prompt; the **presentation order** (Principles → Quran →
Tafsir → Hadith → Kitab → anything unnamed, last) is the assembler's, deliberately distinct.

## Why

A route that decides one thing and a search that does another is this stage's silent failure:
the dimension-to-store-key mapping was a chain of independent `if`s, so a dimension it did not
know reached retrieval as no constraint at all, and nothing noticed. Rejected for the same
reason: a second routing call, mapping an unexpressible dimension to "no constraint", and
assembling the evidence in authority order, which loses the lens its place as the frame.

A category is the route's reading of _what the question is about_, so it cannot speak for a
part the decomposition sent after another source: that part is excluded by construction, the
run answers or refuses with a trace wrong in no field, and only the coverage rule compares the
two. An empty selection stays empty for the reason in reverse: an unfiltered search already
covers every part, and a union over roles alone would drop the part the category _is_ about.
`tafsir` carries hadith because a commentary question's "why" is answered by the Sunnah, and a
route may have no role for saying so.

## Consequences

- The store seam keeps taking opaque filter records; it alone binds a metadata filter in SQL.
- `source_routing` and `filter_relaxed` are additive; the frame omits a block it does not have.
- The rules change by editing one table: vocabulary, role map, filter map and presentation
  order each read one list. Coverage is still not total, and a coverage floor was considered
  and not taken: a category row narrower than the authority order plus a part the route could
  only call `factual`, and a model label stage 2 dropped, which reaches the union role-less and
  is covered by the row alone.
