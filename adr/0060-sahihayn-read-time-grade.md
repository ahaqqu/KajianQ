# ADR-0060: The sahihayn's absent grade is read as sahih, and never written

## Decision

1. **A hadith row with no stored grade whose collection is Bukhari or Muslim is read as `sahih`.** Those are the two collections the term _sahihayn_ names, and what they carry is canonically sahih: the collection itself is the evidence, so the reading needs nothing inferred from the text and nothing fabricated.
2. **The reading is scoped to the two places a grade decides retrieval** — the hierarchy bonus, so a sahihayn row is ranked with the Sahih magnitude, and the `grade` filter, so a `sahih` filter selects it. No other path reads it: a citation label still renders what the corpus stores, and the grade rule still reads the stored grade.
3. **Nothing is written.** No metadata change, no backfill, no migration, no snapshot pair. A citation label renders exactly as ingested, and ADR-0026's refusal to fabricate a grade holds — the corpus stores none, so none is invented there.
4. **A stored grade always wins.** A sahihayn row the source graded weak stays weak, and a hasan verdict keeps the hasan magnitude; the derivation fills an absence, it does not overrule the source.
5. **A row with no grade outside the two collections stays ungraded** — no bonus and no filter match. The derivation is not "ungraded means sahih".
6. **The derivation is the domain pack's, and the engine receives it as data.** The filter's derived case reaches the store as bound keys and values, so the engine names no grade, no collection and no reason, and every other dimension and value keeps exact-equality semantics.

## Why

The product's stated authority order — Quran, then hadith at mutawatir > sahih > hasan, then tafsir, then kitab — is implemented by the hierarchy bonus, which is keyed on the stored grade. The two most authoritative collections carry none, so the order the product claims was implemented backwards for them: a narration graded sahih in a lesser collection outranked an ungraded Bukhari or Muslim one, and a `sahih` filter dropped every row of both collections — excluding exactly the evidence the term names.

Writing the grade into the corpus would have fixed the same fact, and it is the more legible option from stored data. It also rewrites each of those rows' citation labels and stored metadata, a visible product change the ruling did not ask for, and it puts an inferred value into data ADR-0026 keeps source-faithful. Deriving it at read time leaves the corpus as ingested.

Fixing only the filter was rejected: it repairs the more visible half while leaving the ranking inversion in place, and it would let a filter and a bonus disagree about what sahih means.

Rejected: a filter-only fix; a corpus write; and treating every ungraded row as sahih, which would silently promote an unknown to the strongest grade.

## Consequences

- A `sahih` filter now selects the two collections it names, and the bonus ranks them as the authority order states.
- The bonus and the filter resolve one derivation, so they cannot disagree about a row.
- The trace publishes the routing decision's values; the store receives the same decision with each value's derived case attached as data, and no other dimension or value widens.
- No migration, no re-ingestion and no snapshot discipline apply, because nothing about the corpus changes.
- **Revisit when** per-chain grades (ADR-0012's v2) resolve every row from its isnad, leaving the derivation nothing to fill; or when the source itself grades these collections, in which case the stored grade wins and the derivation is inert.
