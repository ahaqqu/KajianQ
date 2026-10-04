# ADR-0026: Hadith v1 draws on fawazahmed0/hadith-api with conservative dhaif-wins grades

## Decision

**The v1 hadith source is fawazahmed0/hadith-api** (Unlicense), fetched per collection as Arabic and Indonesian
edition files through the existing acquisition and archive seams, for the seven canonical collections it carries. The
collections it does not carry are absent from v1 rather than filled from an ungraded scraper: merging those would have
satisfied a "nine books" count while degrading the grade discipline the corpus is built on. No v1 source provides
structured sanad, so the isnad stays embedded in the verbatim source text and per-chain grades remain v2 (ADR-0012).

**Grades consolidate by dhaif-wins.** Any grader asserting a weak class makes the hadith weak; otherwise the weakest
positive class wins, because the compound gradings in the source are weaker than a plain authentic verdict. Empty
grades become null, never fabricated, and the strongest class is never self-asserted from this source. The full
per-grader array is preserved in child metadata for trace transparency. Under-grading is the safe failure mode: weak
material is always flagged at retrieval, whereas over-grading would silently upgrade weak evidence in a trust-first
product.

The weak-class vocabulary is explicit. Weak, and therefore demoting: the various weak gradings and their compounds,
the rejected and anomalous ones, the abrogated, the fabricated, the false, and the interrupted-chain grading — a
"sound chain, interrupted" verdict is self-contradictory, so the defect wins. Not weak: an elevated chain, which is
not a defect and never demotes. The attribution-scope classes are not defects either: they combine freely with
positive grades in the source and are excluded from the weak list, while a bare attribution-scope grading with no
positive class consolidates to null — ungraded and surfaced in the report — never upgraded and never forced weak.
Paired with a genuine defect, the defect fires dhaif-wins anyway.

**Unmatched Arabic/Indonesian pairs are quarantined, never force-merged** (the data-integrity rule), and empty
Indonesian text yields a null Indonesian field that the report surfaces. Rows whose Arabic text is genuinely empty are
quarantined rather than ingested: the source ships them at scale, so gating on them would abort a whole collection
run. They are skipped during alignment, their Indonesian counterpart consumed rather than reported unmatched, and
counted in the report's empty-primary statistic alongside unmatched pairs.

**Lemmatization of hadith Arabic is deferred** to a pre-glossary enrichment step; v1 aligned pairs carry no
morphology, which the field is optional for. And grades stay v1 flattened grades, because hadith science grades chains
rather than texts and v2 fixes that properly (ADR-0012).

## Why

Each candidate the ticket listed was blocked or deficient for v1. The hosted API whose key request is still open
blocks on a human prerequisite and carries no Indonesian translation at all, which the acceptance criteria require
from the start. The dataset previously named in the spec has no license file — default copyright, reuse not granted —
no grade field, and no Indonesian, failing three criteria at once. The sanad dataset is explicitly v2 and its terms
and reconciliation make it the wrong first step. And the MIT Indonesian+Arabic scrapers have no grades and no book or
section structure, so merging one would fill the collection gap with ungraded data.

The chosen source provides what the others lack together: Arabic and Indonesian editions, per-grader grades on the
Arabic side, book and section structure supporting the parent/child hierarchy, alignment keys between editions, and
plain files over a CDN with no key and automated upstream updates.

## Consequences

Hadith ingestion unblocks without any human prerequisite; the open key request is enrichment, not a blocker.

The collections the source does not carry arrive only through a future source decision, and the collection registry in
the domain pack lists exactly what v1 ingested.

The grade filter operates on the consolidated field, so grader-level disagreement is visible in trace metadata but not
filterable until v2 per-chain grades.

Downstream glossary work must tolerate absent morphology on hadith pairs until the enrichment step runs.
