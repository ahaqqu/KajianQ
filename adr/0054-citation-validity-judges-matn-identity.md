# ADR-0054: Citation validity judges Matn identity, not the corpus row

## Decision

A required citation is satisfied when the answer's evidence carries the **same report**, not when it
carries the same corpus row. The scorer resolves every hadith label — the requirement and each evidence
label — through a curated, owner-signed **matn-identity map** to its canonical identity, and compares
identities. The Golden Set keeps one required label per requirement; the map, not the fixture, carries
the parallel chains, and a group's canonical label is the map's identity key rather than the fixture's
required one.

Each group states its **relation**, and the relation decides who may read it:

- `same-report` — one narration through different chains, allowing different wording. It is the gate's
  identity: the only relation citation validity may satisfy a requirement with.
- `same-ruling` — one ruling or instruction carried by different reports, so neither is a parallel chain
  of the other. It is **reported, never gating**: the identity-satisfied measure reads it, and the gate
  does not.

Identity is the **narration**, not the topic: a row that shares only a subject, a narrator, or a legal
theme is a different identity. A label the map does not carry is its own identity, so an unmapped,
fabricated, or unrelated citation can never match another. A refusal carries no citations and still
scores zero. A curator's alternative set is a separate per-question decision, never an identity.

The engine learns no domain vocabulary: it receives injected resolvers and compares opaque keys. The
map is product data, owner-signed like the Golden Set, and gate-affecting.

## Why

After the required labels were re-curated to the hadiths the questions ask for, drafts cited parallel
chains of the same narration and the metric scored them as uncited. The metric's claim — "the required
citation is present" — outran its mechanism, which compared strings. The corpus holds each chain as its
own row, so an exact-row comparison cannot see the identity a reader sees.

The two relations are not interchangeable. A same-ruling narration supports the same ruling but is a
different report, so accepting it as the gate's identity would report a citation as present that no
chain of the required report carries; splitting the relations keeps the gate's number exact and
comparable while the broader relation is still measured.

Rejected: a text-similarity matn test. The v1 corpus keeps the isnad inside the matn and holds
same-topic hadiths that share vocabulary; a threshold that accepts a parallel narration also accepts a
different hadith on the same subject. Identity is curation, not a guess.

Rejected: per-question `requiredCitations` sets, which duplicate the same hadith knowledge across
questions and make every accepted chain a local exception; the canonical identity belongs once, in the map.

Rejected: teaching the generator to prefer the required label: it changes which narration an answer
cites, not whether the metric can see a correct citation.

## Consequences

- The eval scorer and harness accept optional, separate resolvers for the gate and the reported measure;
  without them the exact-label comparison and the historical outcome shape stand for existing callers.
- The identity map is a domain-pack fixture; adding a group or a member is owner-signed, gate-affecting
  curation for the relation it carries, not a test-only edit. Adding a `same-ruling` group moves only the
  reported figure.
- The Golden Set fixture keeps one required label per requirement; no row and no label is re-curated to
  match a model's output.
- An unmapped label can satisfy only the identical required label, a refusal carries no citations and
  stays invalid, and an unrelated hadith stays invalid; those boundaries are pinned in tests.
