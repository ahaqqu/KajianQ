# ADR-0051: The Smart Router returns one typed intent payload and a deterministically repaired set of sub-queries

## Decision

Smart Router stages 1–2 are **one** cheap-tier call returning **one payload**: the intent, the subject category, the
madzhab/grade/text-layer hints, the Principle decision with its tags, a self-reported confidence and rationale, and
role-tagged sub-queries. The domain reads that payload into **closed vocabularies** — a value outside them is dropped,
never force-matched — and a reply whose intent is unusable lands on a deterministic fallback that the Trace marks as
one, never on an invented classification.

Decomposition is **repaired deterministically after the model replies**: every composition rule that fired has a
sub-query carrying its role (a factual one always; a principle one when the question needs a lens; a Quranic dalil one
for fikih; a sanad one for hadith), a missing one is added from a template — or stamped onto the set's role-less entry
for that same text, so the duplicate filter never costs a rule its coverage; an entry the model already labelled with a
different declared role keeps its label, and only that coincidence goes unshown. A text that carries
no letter and no digit in any script is **dropped**, never embedded, **whatever its origin** — the reply's phrasing, a
composition rule's own text, the floor's, or the router fallback's — and the ceiling never spends the slot of the entry a
fired rule's own text lives in — so the repair is a fixed point over its own output. The `factual` rule's text _is_ the
caller's verbatim question, so a content-free question fans out over nothing rather than spending an embed and a pair of
searches on itself, while the principle/dalil/sanad templates carry words of their own and stay searchable. The set is bounded to the stage's
ceiling, with a floor on **distinct retrieval texts**: 2–4 whenever the caller's question plus a differing model
sub-query or a rule beyond `factual` gives two texts to search, and exactly 1 when the question is the only one — the
floor is never padded with a near-duplicate, which would claim a decomposition that never happened. Each sub-query
records what it is for and what produced it — the model, a rule, or the fallback — so a repaired route reads as repaired
on the persisted trace (the frame projects the intent and the sub-query texts).

The payload is **Trace content**: the classification rides the `intent` event's typed confidence and reasoning slots
plus its opaque attributes; each sub-query rides its own `subquery` event with its role and origin. **One module in
the domain pack owns the vocabularies** — the router's prompt, the router's narrowing, the Golden Set fixture's labels
and the eval's trap marker all read that one list.

The **answer prompt is unchanged**: the Generator and the Reviewer read the verbatim question the engine stamps onto
the run's query, never the router's reading of it.

## Why

The classification is the Trace's account of what the system understood, so it must be typed and vocabulary-checked
rather than free text: a value the model invents is not an understanding, and recording it as one makes the trust
surface — the product's whole transparency promise — lie. The decomposition cannot be left to the model alone: a
cheap model asked for a bounded number of sub-queries returns one or nine, and the count is load-bearing twice over —
every sub-query is an embedding and a pair of searches, so an unbounded reply is unbounded cost, and a missing one is
a retrieval angle the stage promised. Splitting the work — the model phrases, the domain guarantees coverage and the
bound — keeps the paraphrase and classical-term quality that makes retrieval work while making the published contract
true by construction. The role and origin labels exist because the alternative is untraceable: a rule-added or
fallback sub-query that passes for the model's own judgment hides exactly the machinery the Trace exists to show.

Rejected: a second cheap-tier call for decomposition — it doubles router latency and cost while its input would be
the first call's output, which one JSON object already carries.

Rejected: a configuration switch that turns decomposition off so a single-query baseline could be measured — that path
was never shipped (the router shipped with the chat route itself), the switch is a second serving mode to maintain that
degrades retrieval silently, and its regression question is answered by a before/after Golden Set run on one deployment.

## Consequences

- The engine carries the payload opaquely — intent, labels, attributes — so no Islamic-domain vocabulary enters an
  engine package, and a second consumer inherits no religious taxonomy.
- The stage returns its reading, not the run's query: the runner stamps the caller's verbatim text and prior turns, so
  a router cannot omit or forge the fields later stages read (ADR-0018).
- A reply the vocabularies cannot read is recorded with its cost and its fallback, never dropped.
- Answer behaviour is untouched, so router quality is measurable against a recorded Golden Set baseline without a
  prompt confound; retrieval recall, citation validity and refusal counts are the instruments.
- Principle retrieval proper — an index the router's tags select, and Arabic expansion candidates from the
  terminology graph — lands behind the same payload; until then a rule-derived principle or evidence sub-query is an
  ordinary retrieval query over the corpus.
