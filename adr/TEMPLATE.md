# ADR TEMPLATE — copy the block, never fill this file in

Copy to `adr/NNNN-<slug>.md`, continuing the numbered sequence. This file is a
template, not a record: it takes no number, and the shapes in it are examples,
not citations. A code-span path written here is counted, never checked, and
nothing pins that count — keep the examples placeholders, and re-derive it when
they change.

## The shape

```markdown
# ADR-NNNN: <the decision, one line, stated flatly>

## Decision

<What is decided, in the present tense. A reader who stops at the end of this
block has the decision.>

## Why

<The trade-off that forced it, and the alternative it costs.>

## Consequences

<What this binds, one line each: the seam it lands behind, the config key that
carries its values, the gate that enforces it.>
```

The record carries no `Status` or `Date` field: a decision is accepted by being
recorded, and its state lives in its `SPECS.md` §8 row — a changed record is
rewritten in place and a deleted one leaves the tombstone there, not here.

## The budget

Target 20–40 lines; 60 is the hard cap; the Decision block comes first and holds
the decision alone — a prose decision fits within 15 lines, and a decision that is
itself a set of enumerated binding clauses runs to the clauses. Say the decision and
its why, and leave the mechanism to the artifact that implements it. Name a value
only where the decision is meaningless without it — the config holds the truth.

## Keep out of the record

Counts, percentages, sizes and prices; model ids and versions; run, sha and trace
ids; `file:line` citations and test enumerations; implementation maps, evidence
dumps and PR play-by-play; "today" and "currently", because a record has no
present tense; amendment chains, because a changed decision is rewritten in place
and a superseded one is deleted, leaving one tombstone line in `SPECS.md` §8.

How a mechanism works is out too: a gate's internals, a script's algorithm, a
prompt's wording, a workflow's step order. State the decision the mechanism
serves — "a CI gate runs on every merge to `main`", "the reviewer's draft is
screened before the paid model is called" — and let the artifact carry the rest.
