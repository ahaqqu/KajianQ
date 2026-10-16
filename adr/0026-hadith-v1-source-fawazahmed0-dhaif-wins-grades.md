# ADR-0026: Hadith v1 draws on a graded open source, with dhaif-wins consolidation

## Decision

**Source.** The v1 hadith source is the openly licensed `fawazahmed0/hadith-api` dataset, fetched per collection as Arabic and Indonesian editions through the acquisition and archive seams, for the canonical collections it carries; the rest stay absent rather than filled from an ungraded scraper. No v1 source provides structured sanad, so the isnad stays embedded in the verbatim source text and per-chain grades remain v2 (ADR-0012).

**Grades consolidate by dhaif-wins.** Any grader asserting a weak class makes the hadith weak; otherwise the weakest positive class wins. Empty grades become null, never fabricated, and the strongest class is never self-asserted from this source. The weak vocabulary is explicit and lives in one place in code: every compound weak grading demotes, the attribution-scope classes are excluded rather than upgraded or forced weak, and the full per-grader array is preserved on the chunk's metadata for trace transparency.

**Unmatched Arabic and Indonesian pairs are quarantined, never force-merged.** An empty primary text is quarantined too, and an empty translation yields a null field the report surfaces.

## Why

Each alternative was blocked or deficient. A hosted API whose key request is still open locks ingestion behind a human prerequisite and carries no translation, which the acceptance criteria require from the start. A dataset with no licence file grants no reuse, and one with no grades would fill the collection gap with ungraded data — a collection count bought by degrading the grade discipline the corpus is built on. The sanad dataset is explicitly v2, its terms and reconciliation making it the wrong first step.

The chosen source provides what the others lack together: both language editions, per-grader grades, book and section structure supporting the parent/child hierarchy, and alignment keys between editions. Dhaif-wins is the safe failure direction, because weak material is always flagged at retrieval while over-grading would silently upgrade weak evidence in a trust-first product; the source's compound gradings are weaker than a plain authentic verdict, and an interrupted chain's verdict is self-contradictory.

## Consequences

- Hadith ingestion unblocks with no human prerequisite; the open key request is enrichment, not a blocker.
- The weak-class vocabulary is a single source of truth in code, read by both grade consolidation and the report's statistics.
- The grade filter operates on the consolidated field, so grader-level disagreement is visible in trace metadata but not filterable until per-chain grades.
- Collections the source does not carry need a future source decision; the domain pack's registry lists what v1 ingested.
- **Revisit when** a source with structured sanad under a compatible licence is available (ADR-0012's v2 work).
