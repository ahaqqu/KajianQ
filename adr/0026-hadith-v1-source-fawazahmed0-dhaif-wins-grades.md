# ADR-0026: Hadith v1 draws on fawazahmed0/hadith-api with conservative dhaif-wins grades

## Decision

**The v1 hadith source is fawazahmed0/hadith-api** (Unlicense), fetched per collection as Arabic and Indonesian
edition files through the existing acquisition and archive seams, for the seven canonical collections it carries; the
rest stay absent rather than filled from an ungraded scraper. No v1 source provides structured sanad, so the isnad
stays embedded in the verbatim source text and per-chain grades remain v2 (ADR-0012).

**Grades consolidate by dhaif-wins.** Any grader asserting a weak class makes the hadith weak; otherwise the weakest
positive class wins. Empty grades become null, never fabricated, and the strongest class is never self-asserted from
this source. The full per-grader array is preserved in child metadata for trace transparency.

The weak-class vocabulary is explicit. Weak, therefore demoting: `Daif` and every compound ("Very Daif", "Daif
Isnaad", "Sanad Daif"), `Munkar`, `Shadh`, `Mansukh`, `Mawdu`, `Batil`, and `Mursal` — the defect wins. Not weak:
`Marfoo`. The attribution-scope classes `Mauquf`/`Muquf`/`Maqtu` are excluded, and a bare one consolidates to null —
ungraded, surfaced in the report — never upgraded and never forced weak; a genuine defect fires anyway.

**Unmatched Arabic/Indonesian pairs are quarantined, never force-merged** (the data-integrity rule), and empty
Indonesian text yields a null Indonesian field the report surfaces. Empty Arabic is quarantined too — skipped during
alignment, counterpart consumed, not reported unmatched — and counted in the empty-primary statistic alongside
unmatched pairs.

**Lemmatization of hadith Arabic is deferred** to a pre-glossary enrichment step; v1 aligned pairs carry no
morphology, which the field is optional for. And grades stay v1 flattened grades, v2 fixing that properly (ADR-0012).

## Why

Each candidate the ticket listed was blocked or deficient. The hosted API whose key request is still open blocks on a
human prerequisite and carries no Indonesian translation, which the acceptance criteria require from the start. The
dataset previously named in the spec has no license file — default copyright, reuse not granted — no grade field, and
no Indonesian. The sanad dataset is explicitly v2, its terms and reconciliation making it the wrong first step. The
MIT Indonesian+Arabic scrapers have no grades and no book or section structure, so merging one fills the collection
gap with ungraded data — a "nine books" count bought by degrading the grade discipline the corpus is built on.

The chosen source provides what the others lack together: Arabic and Indonesian editions, per-grader grades on the
Arabic side, book and section structure supporting the parent/child hierarchy, alignment keys between editions, and
plain files over a CDN with no key and automated upstream updates.

The consolidation is lopsided: the compound gradings in the source are weaker than a plain authentic verdict, and
under-grading is the safe failure mode — weak material is always flagged at retrieval, whereas over-grading would
silently upgrade weak evidence in a trust-first product. Three named classes only look weak: a "sound chain,
interrupted" verdict is self-contradictory, so the interrupted chain demotes; `Mawdu` is the fabricated class; and the
attribution-scope classes combine freely with positive grades in the source ("Mauquf Sahih" is the common form), while
`Marfoo` is a chain form rather than a defect. The source ships empty Arabic at scale, so gating on it would abort a
whole collection run. Grades stay flattened because hadith science grades chains rather than texts.

## Consequences

Hadith ingestion unblocks without any human prerequisite; the open key request is enrichment, not a blocker.

The weak-class tokens are not a prose list but a single source of truth in code: `WEAK_GRADE_RE` in
`packages/kajianq-domain/src/hadith-source.ts`, which both grade consolidation and the report statistics read.

The collections it does not carry need a future source decision; the domain pack's registry lists what v1 ingested.

The grade filter operates on the consolidated field, so grader-level disagreement is visible in trace metadata but not
filterable until v2 per-chain grades, and downstream glossary work must tolerate absent morphology on hadith pairs
until the enrichment step runs.
