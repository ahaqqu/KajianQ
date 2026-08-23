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
| _(example — remove as real entries land)_ | — | — | — | — | — |

## Planned seed sources (per ADR-0014 §License-safe seed sources)

These are the license-vetted seed resources for the Terminology Glossary
concept graph. They are recorded here up front; each gets a full row when
ingested.

| Resource | License | Role | Link |
|---|---|---|---|
| QSAC (Quran Semantic Annotation Corpus) | CC BY 4.0 | Quranic concept seed | https://github.com/… _(record exact URL on ingest)_ |
| Quranic Arabic Corpus morphology | GPL | Arabic lemmas (reference; corrections kept in a separate layer) | https://corpus.quran.com |
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
