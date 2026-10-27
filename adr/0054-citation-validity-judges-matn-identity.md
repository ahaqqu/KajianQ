# ADR-0054: Citation validity judges Matn identity, not the corpus row

## Decision

A required citation is satisfied when the answer's evidence carries an address the **matn-identity map**
relates to the required narration, not when it carries the same corpus row. Both relations the map records
are gate identities:

- `same-report` — one narration through different chains, allowing different wording.
- `same-ruling` — one ruling, instruction, or stated merit carried by another report.

A cited narration that states the same ruling is therefore a valid citation. The map, not a single address,
is the gate's unit of identity: the required label resolves to a **component** — every group the map ties to
it through a shared label — and every member of it satisfies the requirement. The relation still states which
claim the group makes — one report or one ruling — and a label the map does not carry is its own identity, so
an unmapped, fabricated, or unrelated citation can never match another.

The Golden Set keeps one required label per requirement and the exact-address measure keeps its exact
meaning. A curator's alternative set stays a separate per-question decision: a member is matched as its own
normalized label, never as an entry point into its identity family, and the map's widening applies only to
the required label's component.

The engine learns no domain vocabulary: it receives injected resolvers and compares opaque keys. The map
is product data, owner-signed like the Golden Set, and its accuracy is what the gate's verdict depends on.

## Why

The metric's claim — "the required citation is present" — is a claim about grounding, not about one book's
numbering. An answer that grounds its ruling in a parallel chain or in another companion's report of the
same ruling has cited valid evidence; a gate that rejects it measures which addresses the sampler happened
to retrieve and cite, not whether the answer is grounded. The map records that relation once, under owner
review, and the gate reads it: the curator states the identity, the scorer applies it.

The two relations are not interchangeable as claims — one narration's chains versus one ruling, instruction,
or stated merit under different reports — but they are interchangeable as identities for this gate, because
both answer the question the metric asks. Keeping only one made the gate's verdict turn on which of two
equally valid narrations a draw cited, so the same evidence could pass or fail by sampling.

Rejected: a text-similarity matn test. The v1 corpus keeps the isnad inside the matn and holds same-topic
hadiths that share vocabulary; a threshold that accepts a parallel narration also accepts a different hadith
on the same subject. Identity is curation, not a guess.

Rejected: per-question accepted-answer sets in place of the map. They duplicate one hadith's identity across
rows and make every accepted narration a local exception; the relation belongs once, in the map.

Rejected: teaching the generator to prefer the required label. It changes which narration an answer cites,
not whether the metric can see a correct citation.

## Consequences

- The eval scorer accepts an injected identity resolver for the gate; without one the exact-label
  comparison and the historical outcome shape stand for existing callers.
- The identity map is a domain-pack fixture; adding a group or a member is owner-signed, gate-affecting
  curation for the relation it carries, not a test-only edit. A wrong member of any group in a component
  widens the gate, and any member edit in a component changes what citation validity accepts.
- The exact-address measure is unchanged and stays comparable with past runs; the identity-satisfied figure
  keeps its meaning as the reported counterfactual where a signed identity also satisfies the address
  reading.
- An unmapped label can satisfy only the identical required label, a refusal carries no citations and stays
  invalid, and an unrelated hadith stays invalid; those boundaries are pinned in tests.
