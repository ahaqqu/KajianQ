# Dataset & corpus attributions

KajianQ ingests classical Islamic sources and seed linguistic resources. This
file is the **attribution register**: every dataset, corpus, or linguistic
resource the project touches gets a row here **in the same PR that introduces
it** (AGENTS.md §3 step 4). Keeping attribution next to the code — not in a
wiki — means a redistribution never ships without its licenses.

## How to add an entry

Copy a row, fill every column, and keep the license text accurate. When a
resource's license obliges share-alike or attribution wording, quote the exact
notice in `Notes` and follow it precisely. Resources ruled out for license
reasons are recorded at the bottom so the decision is auditable and not
re-litigated.

| Resource | Version / date | License | Source URL | Used for | Attribution / Notes |
|---|---|---|---|---|---|
| Tanzil Uthmani Quran text | Uthmani script, as mirrored 2026-08 | Tanzil Terms of Use: verbatim copy/distribution permitted with attribution + link to tanzil.net; no modification of the text | https://tanzil.net/download (fetched via the `hangsbreaker/quran-json` GitHub mirror) | Arabic primary evidence text (`text_ar` / `embedding_ar`), issue #6 | Mirror declares no separate license; the Arabic text is the Tanzil Uthmani edition and is redistributed only verbatim. Raw bytes archived to R2 (`quran/tanzil-uthmani-kemenag/`), never committed to the repo. |
| Kemenag Quran Indonesian translation | As published by Kemenag RI API, mirrored 2026-08 | Copyright Kementerian Agama RI — no open machine-readable license | https://quran.kemenag.go.id (fetched via the `hangsbreaker/quran-json` GitHub mirror) | Indonesian secondary track (`text_id` / `embedding_id`), issue #6 | **Redistribution is gated by human prerequisite #2 (Kemenag licensing verification).** Until #2 closes, the translation is used for internal ingestion/embedding only and the raw archive stays in the project's own R2 bucket. Mirror declares no license — flagged, not assumed. |
| Quranic Arabic Corpus morphology (0.4) | quranic-corpus-morphology-0.4 | GPL | https://corpus.quran.com | Per-token Arabic lemma+root alongside `text_ar` (issue #6); build dependency per ADR-0014 | Gold-standard hand-verified morphology for all 6,236 ayahs. GPL: consumed at build/ingestion time; corrections to corpus data are kept in a separate layer, never copied forward as if original. Keyed to the same diacritized Uthmani text as the Tanzil edition. |
| fawazahmed0/hadith-api editions | branch `1` (pinned tag), as fetched 2026-09 | The Unlicense (public domain dedication) | https://github.com/fawazahmed0/hadith-api (served via cdn.jsdelivr.net) | Hadith Arabic primary text + Indonesian translation + per-grader grades + book/section structure (`ingest:hadith`, issue #7) | 7 collections (Bukhari, Muslim, Abu Dawud, Tirmidhi, Nasai, Ibn Majah, Muwatta Malik). Underlying texts originate from sunnah.com scrapes — attribute sunnah.com alongside. Grades consolidated per ADR-0026 (dhaif-wins); raw per-grader arrays preserved in metadata. No structured sanad in v1 (isnad embedded in `text_raw`; per-chain grades are ADR-0012/v2). Raw bytes archived to R2 (`hadith/fawazahmed0-hadith-api/`), never committed to the repo. |
| Sunnah.com hadith texts | As scraped upstream into fawazahmed0/hadith-api | Upstream terms apply; texts of classical collections are public domain, translation wording per sunnah.com terms | https://sunnah.com | Underlying origin of the hadith Arabic/English editions (issue #7) | Attribution owed to sunnah.com as the upstream source of the fawazahmed0 editions. A direct Sunnah.com API integration (key pending in issue #2) would be governed by sunnah.com's API terms separately. |

## Planned seed sources (per ADR-0014 §License-safe seed sources)

These are the license-vetted seed resources for the Terminology Glossary
concept graph. They are recorded here up front; each gets a full row when
ingested.

| Resource | License | Role | Link |
|---|---|---|---|
| QSAC (Quran Semantic Annotation Corpus) | CC BY 4.0 | Quranic concept seed | https://github.com/… _(record exact URL on ingest)_ |
| Arabic WordNet (OMW) | CC BY-SA 3.0 | Arabic synset seed/validate | https://omwn.org |
| Wordnet Bahasa (Indonesian, OMW) | MIT | Indonesian synset seed/validate | https://omwn.org |
| CILI (Interlingual Index) | CC BY 4.0 | Language-neutral concept IDs | https://github.com/globalwordnet/cili |
| Lane's Arabic-English Lexicon | Public domain (pre-1929) | Arabic lemma validation | Internet Archive / Perseus |

## Ruled out (license-incompatible — do not ingest)

Recorded so the decision is auditable (ADR-0014):

- **BabelNet** — CC BY-NC-SA (non-commercial): incompatible with the MIT repo.
- **Quranic Ontology** (~300 concepts) — GPL: consult to validate only, never
  copy/redistribute into the MIT repo.
- **al-Munawwir dictionary** — modern copyright: human reference only.
- **Kemenag / NU / Persis glossaries** — no open machine-readable license found.
