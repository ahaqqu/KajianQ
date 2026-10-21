# ADR-0054: Citation validity judges Matn identity, not the corpus row

## Decision

A required citation is satisfied when the answer's evidence carries the **same hadith**, not when it
carries the same corpus row. The scorer resolves every hadith label — the requirement and each evidence
label — through a curated, owner-signed **matn-identity map** to its canonical identity, and compares
identities. The Golden Set keeps one required label per requirement; the map, not the fixture, carries
the parallel chains, and a group's canonical label is the map's identity key rather than the fixture's
required one.

Identity is the **narration**, not the topic: rows share an identity when they carry the same report or
instruction, allowing different wording and a different chain. A row that shares only a subject, a
narrator, or a legal theme is a different identity. A label the map does not carry is its own identity,
so an unmapped, fabricated, or unrelated citation can never match another. A refusal carries no
citations and still scores zero.

The engine learns no domain vocabulary: it receives an injected resolver and compares opaque keys. The
map is product data, owner-signed like the Golden Set, and gate-affecting.

## Why

After the required labels were re-curated to the hadiths the questions ask for, drafts cited parallel
chains of the same narration and the metric scored them as uncited. The metric's claim — "the required
citation is present" — outran its mechanism, which compared strings. The corpus holds each chain as its
own row, so an exact-row comparison cannot see the identity a reader sees.

Rejected: a text-similarity matn test. The v1 corpus keeps the isnad inside the matn and holds
same-topic hadiths that share vocabulary; a threshold that accepts a parallel narration also accepts a
different hadith on the same subject. Identity is curation, not a guess.

Rejected: per-question `requiredCitations` sets. They duplicate the same hadith knowledge across
questions and make every accepted chain a local exception; the canonical identity belongs once, in the
map the metric reads.

Rejected: teaching the generator to prefer the required label. That changes which narration an answer
cites, not whether the metric can see a correct citation, and it belongs to the over-refusal work.

## Consequences

- The eval scorer and harness accept an optional identity resolver; without one they keep the exact-label
  comparison, so the engine's existing callers and the recorded replays are unchanged.
- The identity map is a domain-pack fixture; adding a group or a member is a gate-affecting, owner-signed
  curation change, not a test-only edit.
- The Golden Set fixture keeps one required label per requirement; no row and no label is re-curated to
  match a model's output.
- An unmapped label can satisfy only the identical required label, a refusal carries no citations and
  stays invalid, and an unrelated hadith stays invalid; those boundaries are pinned in tests.
