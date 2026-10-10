# ADR-0052: Retrieval filters are set-valued behind one exhaustive map, and source routing covers every part the route decomposed

## Decision

Smart Router stage 3 selects the sources a question is answered from, and the metadata
filters retrieval runs with, by **rules over the router's reading** — never a second
model call — and records the decision as typed trace content: which sources may answer
a question is a published product decision (`SPECS.md` §2.2, the usul authority order),
not a cheap model's to get silently wrong.

**Route-wide coverage.** The selection is the **union** of what the route's Query
category implies and what **every Sub-query's own role** implies, derived from the
Sub-queries retrieval actually fans out over:

| reading / part                                            | sources selected            |
| --------------------------------------------------------- | --------------------------- |
| `category: quran` / `hadith`                              | `quran` / `hadith`          |
| `category: tafsir`                                        | `quran`, `tafsir`, `hadith` |
| `category: fikih`                                         | `quran`, `hadith`, `kitab`  |
| a `dalil` or `sanad` part                                 | `hadith`                    |
| a `principle` part, `intent: analogy`, a needed Principle | `principle`                 |
| a `factual` part                                          | nothing of its own          |
| no subject area settled                                   | none — every source         |

Both maps are exhaustive `Record`s over the vocabulary that owns them: a category or
role added without a decision here is a typecheck failure, and a role the mapping
cannot express **fails the run** where it must become a filter — an empty category
selection stays empty, since a role or a lens may widen a selection but never turn
"every source" into a filter.

Every filter dimension is a **set** behind one exhaustive map that fails the run on an
unexpressible dimension; a filter matching nothing is **probed** dimension by dimension.

The **authority order** (Quran → Hadith (mutawatir > sahih > hasan; dhaif flagged) →
Tafsir → Kitab) is the Generator's system prompt; the **presentation order** (Principles
→ Quran → Tafsir → Hadith → Kitab → anything unnamed, last) is the assembler's. The two
are deliberately distinct.

## Why

A route that decides one thing and a search that does another is this stage's silent
failure: the dimension-to-store-key mapping was a chain of independent `if`s, so a
dimension it did not know reached retrieval as no constraint at all, and nothing
noticed.

A category is the route's reading of _what the question is about_, so it cannot speak
for a part the decomposition sent after another source: that part is excluded by
construction, the run answers or refuses with a trace wrong in no field, and only the
coverage rule compares the two. An empty selection stays empty for the reason in
reverse: an unfiltered search already covers every part, and a union over roles alone
would drop the part the category _is_ about. `tafsir` carries hadith because a commentary
question's "why" is answered by the Sunnah, and a route may have no role for saying so.
Still open: a narrower category row plus a `factual`-only part can omit a source; a
coverage floor was considered and not taken.

## Consequences

- The store seam keeps taking opaque filter records; it alone binds a metadata filter in SQL.
- `source_routing` and `filter_relaxed` are additive; the frame omits a block it does not have.
- The rules change by editing one table: vocabulary, role map, filter map and presentation order each read one list.
