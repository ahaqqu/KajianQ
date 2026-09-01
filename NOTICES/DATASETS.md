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
