# ADR-0052: Retrieval filters are set-valued dimensions behind one exhaustive map, and the routing decision is trace content

## Decision

Smart Router stage 3 selects the sources a question is answered from and the
metadata filters the route decided retrieval should run with, by **rules over the
router's reading** — never a second model call — and records the decision as typed
trace content: the selected sources and the filter record the searches were handed.

Every filter dimension is a **set**, mapped to its store key in **one exhaustive
map**: a dimension added without a store key is a typecheck failure, and one the
store cannot express — an unknown name, a value that is not a list of non-empty
strings — **fails the run** where it was decided.

A filter that matches nothing is **probed**, not discarded wholesale: each probe
omits one dimension and records the record it ran with and the hits it returned,
and only an adopted drop is kept for the run — what any search ran with is
`intended − every adopted drop`. A sweep that adopts nothing — no single dimension
at fault — ends in ONE retry with `{}`, recorded as an adopted whole-record drop: a
wrong hint must not become a refusal for a question the corpus can serve.

The **authority order** (Quran → Hadith (mutawatir > sahih > hasan; dhaif
flagged) → Tafsir → Kitab) is stated by the Generator's system prompt. The
**presentation order** (Principles → Quran → Tafsir → Hadith → Kitab → anything the
order does not name, last) is the assembler's. The two are deliberately distinct.

## Why

A route that decides one thing and a search that does another is the failure this
stage can introduce silently: the dimension-to-store-key mapping was a chain of
independent `if`s, so a dimension the router could decide but the mapping did not
know reached retrieval as no constraint at all, and nothing noticed.

Which sources may answer a question is a published product decision (the usul
authority order, `SPECS.md` §2.2), not a classification a cheap model should get
silently wrong: without it the trace shows what was retrieved, never what was chosen.

The relaxation exists because an inferred hint that empties the context makes the
answer uncitable, and because emptying the whole record to rescue one wrong hint
was itself a silent widening — it cost a grade screen with the hint actually at
fault — while one event naming the whole set could not tell one bad hint from four.
The two orderings answer different questions — the lens is _how_ evidence is read,
authority is _which_ evidence governs — and collapsing them would make the
assembler's layout a claim.

Rejected: a second cheap-tier call for routing, which doubles latency and cost for a
decision rules already express; mapping an unexpressible dimension to "no
constraint", the defect restated as policy; and ordering the evidence by authority,
which loses the lens's place as the frame.

## Consequences

- The store seam keeps taking opaque `Record<string, string | readonly string[]>` and
  stays the only place SQL binds a metadata filter.
- `source_routing` and `filter_relaxed` are additive: older traces still parse and
  render, and the frame omits a routing block it does not have.
- The relaxation is bounded to one diagnosis per run — the hints belong to the request,
  not to one sub-query — so `principleTags` probes away and says so before #16 exists.
- The rules change by editing one table; the vocabulary, filter map and presentation
  order each read one list.
