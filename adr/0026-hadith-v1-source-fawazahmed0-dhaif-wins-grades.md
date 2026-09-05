# ADR-0026 — Hadith v1 source: fawazahmed0/hadith-api with conservative dhaif-wins grade consolidation

- **Status:** Accepted (2026-09-01); Amended (2026-09-05 — weak-class vocabulary enumerated, review A3/C4)
- **Context:** Ticket #7 (hadith ingestion) needed a v1 data source; the ticket's listed candidates each had a blocker (Sunnah.com API key pending in #2, AhmedBaset/hadith-json unlicensed and grade-less, Sanadset v2-only)
- **Deciders:** repo owner (source decision + conservative grade policy confirmed 2026-09-01)
- **Supersedes:** nothing; amends the SPECS §4.1 source table (hadith-json row replaced)
- **Amends:** nothing

## Context

Ticket #7 names three candidate sources, all blocked or deficient for v1:

- **Sunnah.com API** — the key request (issue #2) is still open, so #7 was
  blocked on a human prerequisite. It also has no Indonesian translation at
  all, which the ticket's acceptance criteria require from the start.
- **AhmedBaset/hadith-json** (the SPECS §4.1 listed dataset) — **no license
  file at all** (default copyright: reuse not granted by the page), **no
  grade field**, and no Indonesian. It fails three of the ticket's
  acceptance criteria simultaneously.
- **Sanadset (Kaggle)** — explicitly v2 (ADR-0012); 650K rows with sanad,
  but Kaggle terms + reconciliation make it the wrong first step.
- **gadingnst/hadith-api / renomureza/hadis-api-id** (MIT, Indonesian +
  Arabic, 9 books incl. Musnad Ahmad + Sunan ad-Darimi) — scraped from
  tafsirq.com with **no grades and no book/section structure**; merging it
  would have filled the 9-books gap with ungraded data.

Meanwhile **fawazahmed0/hadith-api** (Unlicense — public-domain dedication)
provides, for seven canonical collections (Bukhari, Muslim, Abu Dawud,
Tirmidhi, Nasai, Ibn Majah, Muwatta Malik):

- Arabic **and Indonesian** editions (plus English/Urdu we do not use);
- **per-grader grades** on the Arabic editions (Al-Albani, Shuaib Al Arnaut,
  Zubair Ali Zai, Ahmad Muhammad Shakir, …) with values like `Sahih`,
  `Hasan Sahih`, `Sahih Lighairihi`, `Daif`, `Munkar`, `Shadh`, `Very Daif`;
- book/section structure (`metadata.sections` titles + hadith-number
  ranges) supporting the parent/child hierarchy;
- alignment keys between editions (`reference.book` + `arabicnumber`);
- JSON files over the jsDelivr CDN, no API key, automated upstream updates.

Two v1 gaps are accepted and documented: **Musnad Ahmad and Sunan ad-Darimi
are absent from the source** (7 of the 9 canonical books — adding them would
mean merging an ungraded scraper, declined), and **no v1 source provides
structured sanad** — the isnad stays embedded in the verbatim `text_raw`,
and per-chain grades remain v2 (ADR-0012, Sanadset).

## Decision

1. **v1 hadith source is `fawazahmed0/hadith-api`** (Unlicense), fetched as
   per-collection (ara-*, ind-*) edition files through the existing
   acquisition/archive seams; the Sunnah.com key request (issue #2) stays
   open for future enrichment but no longer blocks #7.
2. **Conservative dhaif-wins grade consolidation** into the CONTEXT.md
   4-value vocabulary: any grader asserting a weak class makes the hadith
   `dhaif`; otherwise the weakest positive class wins (Hasan-class → `hasan`
   beats Sahih-class → `sahih`, because "Hasan Sahih" and "Sahih
   Lighairihi" are weaker than plain Sahih). Empty grades → `null`, never
   fabricated. `mutawatir` is never self-asserted from this source. The
   full per-grader array is preserved in child metadata for trace
   transparency. Rationale: dhaif material is always flagged at retrieval,
   so under-grading is the safe failure mode; over-grading would silently
   upgrade weak evidence in a trust-first product.

   **Amendment (2026-09-05, review A3/C4) — the weak-class list is
   explicit**, verified against the live editions' grade vocabulary:

   - **Weak (→ `dhaif`):** `Daif` (all compounds — "Very Daif", "Daif
     Isnaad", "Sanad Daif", …), `Munkar`, `Shadh`, `Mansukh`, `Mawdu`
     (fabricated), `Batil`, `Mursal` (missing-Companion chain — an
     "Isnaad Sahih Mursal" grading is self-contradictory, so the defect
     wins).
   - **Not weak:** `Marfoo` (an elevated chain, not a defect — it never
     demotes). `Mauquf`/`Muquf`/`Maqtu` are attribution-scope classes, not
     defects: they combine freely with positive grades in the source
     ("Mauquf Sahih" is the most common form), so they are excluded from
     the weak list; a *bare* `Maqtu`/`Mauquf` (no positive class attached)
     consolidates to `null` (ungraded, surfaced via the report), never
     upgraded to sahih/hasan and never forced to `dhaif`. When paired with
     a genuine defect ("Maqtu Daif") the defect token fires dhaif-wins
     anyway.

3. **Unmatched ara/ind pairs are quarantined in the report, never
   force-merged** (AGENTS.md data-integrity rule); empty Indonesian text
   yields `text_id: null` (surfaced in the report, common for Shadh
   narrations in the source).

   **Amendment (2026-09-05, review A2):** rows with genuinely empty Arabic
   text are quarantined, not ingested — the source ships them at scale
   (86 in ara-nasai, 29 in ara-malik, muslim's book-0 rows), so gating on
   them aborts the whole run. They are skipped during alignment (their
   Indonesian counterpart is consumed, not reported unmatched) and counted
   in the report's `emptyPrimary` stat, which feeds the report's
   `quarantined` count alongside unmatched pairs.
4. **CAMeL Tools lemmatization (ADR-0014) is deferred** to a pre-#24
   enrichment step; hadith aligned pairs carry `morphology: []` in v1 (the
   field is optional per contracts). Ticket #7 does not add a Python
   sidecar.
5. Grade values remain **v1 flattened grades** (per ADR-0012's own scoping:
   hadith science grades chains, not texts — v2 fixes this properly).

## Consequences

- #7 unblocks without any human prerequisite; Phase 1's "Quran + hadith
  ingested & embedded" gate no longer waits on issue #2.
- Musnad Ahmad + Sunan ad-Darimi coverage arrives only via a future source
  decision (Sunnah.com key, or a graded replacement) — the collection
  registry in `kajianq-domain` lists exactly the seven v1 collections.
- The grade filter operates on the consolidated field; grader-level
  disagreement is visible in Trace metadata but not filterable until v2
  per-chain grades (ADR-0012).
- Downstream consumers (#24) must tolerate `morphology: []` on hadith pairs
  until the pre-#24 enrichment runs.