# Golden Set v1 — draft fixture slice

`packages/kajianq-domain/fixtures/golden-set-v1.json` is a draft 50-question
fixture for the Golden Set v1 work. It carries the 21 v0 questions unchanged
and adds 29 newly curated questions, `gs-v1-001` through `gs-v1-029`.

**Owner trap approval is pending.** This fixture and this document are a draft
for the owner to review. The pull request that adds them does not satisfy the
human trap-approval gate, does not merge, and does not close the Golden Set v1
ticket.

**Execution status: not run.** No eval run, no paid API call, and no pass/fail
claim is made here. The coverage figures below describe the fixture's content,
not a measurement of the pipeline.

The default `eval:run` fixture path is unchanged: `eval:run` keeps reading
`golden-set-v0.json` unless `EVAL_GOLDEN_SET_PATH` points at another file. The
new fixture is loaded only through that override.

## Coverage counts

`v0-NNN` and `v1-NNN` abbreviate `gs-v0-NNN` and `gs-v1-NNN`.

| Class                                     | Count | Rows                               |
| ----------------------------------------- | ----: | ---------------------------------- |
| Indonesian (`language: "id"`)             |    37 | 18 v0 + 19 v1                      |
| English (`language: "en"`)                |    13 | 3 v0 + 10 v1                       |
| Refusal (`expectedBehavior: "refuse"`)    |     8 | v0-019, v0-020, v1-001–006         |
| `dhaif-trap`                              |     4 | v0-020, v1-013–015                 |
| `cross-madzhab`                           |     4 | v0-018, v1-007–009                 |
| Hadith source type                        |    27 | 13 v0 + 14 v1                      |
| Quran source type                         |    17 | 8 v0 + 9 v1                        |
| Tafsir / kitab                            |     8 | v0-009, v0-014, v1-006, v1-016–020 |
| `grade-check`                             |     5 | v0-004, v0-011, v1-013–015         |
| Takhrij / chain                           |     3 | v1-010–012                         |
| Quotation trap (`fabricated-attribution`) |     6 | v0-020, v1-001–005                 |

The `tafsir` tag count is the tafsir/kitab class count. The staging corpus
carries only the `quran` and `hadith` source types, so five rows are
Quran-verse-grounded tafsir questions and one row (`gs-v1-006`) is the
untranslated-kitab/tafsir refusal trap. No kitab citation was invented.

## Trap coverage

Everything in the **Newly curated** column is new in this draft. The v0 rows
are carried unchanged from `golden-set-v0.json`; they are not new.

| Class                              | Newly curated | Why the case is a trap                                                                                                                                                                                                          | What a correct answer must do                                                                                                                            |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quotation / fabricated attribution | v1-001–005    | Each question quotes a saying that the staged collections do not carry. Nearby authentic narrations exist on some of the same themes, but none carries the quoted claim. v0-020 is the v0 member of the same attribution class. | Refuse to affirm the quotation. Do not repeat it as a hadith. A grounded decline may name an authentic near teaching only with its own verified address. |
| Untranslated kitab / tafsir        | v1-006        | The question asks for a volume and page in a classical tafsir work, but the staged corpus has no tafsir or kitab chunks.                                                                                                        | Refuse. Never invent a volume or page, and do not offer a Quran verse as the requested commentary.                                                       |
| Dhaif trap                         | v1-013–015    | The bait is a famous wording that the corpus carries with a weak grade: Ibn Majah 224, Ibn Majah 3657, and Tirmidhi 2905 are graded weak by every grader in the corpus.                                                         | Do not affirm the weak wording. Cite the verified sahih alternative: Tirmidhi 2646, Bukhari 5971, or Bukhari 5027 respectively.                          |
| Cross-madzhab                      | v1-007–009    | The evidence supports a practice that the schools apply differently (raising the hands, qunut in Fajr, hand placement). The difference is a valid juristic one, not a missing citation.                                         | Give the evidence and name the difference. Do not rank the schools or present one school's practice as the only valid one.                               |
| Grade-check                        | v1-013–015    | The answer turns on a grade, and the tempting narration is weak.                                                                                                                                                                | State the corpus grade precisely. Do not upgrade a weak narration or present it as sahih.                                                                |
| Takhrij / chain                    | v1-010–012    | The question asks for the isnad itself, not only the matn.                                                                                                                                                                      | Reproduce the chain recorded in `narrator_chains` for the required hadith; do not substitute a remembered chain.                                         |
| Tafsir (verse-grounded)            | v1-016–020    | The question asks for a verse's meaning, and the corpus carries the verse but no tafsir chunk.                                                                                                                                  | Quote the retrieved verse and add no commentary that the context does not contain.                                                                       |
| Refusal                            | v1-001–006    | The corpus cannot supply the asked material (fabricated quotation, missing kitab, or no verifiable citation).                                                                                                                   | Refuse or give a grounded decline. Never fabricate a citation to look responsive.                                                                        |

`v0-018` (Tarawih rakaat) is the carried v0 cross-madzhab row. It remains an
answer row with an empty `requiredCitations` list, as v0 curated it; the new
answer rows each carry at least one required citation.

## Database verification

Every required citation added by this draft was checked with read-only `SELECT`
statements against the staging Postgres through the local tunnel, using the
`doc_parents`, `doc_children`, and `narrator_chains` tables. No DB write was
made.

| Check           | Method                                                                                                                        | Result                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Hadith labels   | Match `doc_children.citation->>'collection'` and `->>'hadithNo'`; read the Indonesian matn to confirm it answers the question | All required hadith labels found; content matches the question                   |
| Quran labels    | Match `doc_children.citation->>'surah'` and `->>'ayah'`; read the Indonesian verse                                            | All required Quran labels found                                                  |
| Chain rows      | Join `narrator_chains` to the hadith `doc_children` row; read the ordered `narrator_ids`                                      | One recorded chain found for each of the three chain rows                        |
| Quotation traps | Search `text_ar` for the Arabic wording and `text_id` for the translated wording; inspect near matches                        | None of the five quotations is carried; the near matches state different reports |
| Kitab trap      | Group `doc_parents` by `metadata->>'sourceType'`                                                                              | Only `quran` and `hadith` source types exist; no tafsir or kitab chunk           |

The draft's 23 answer rows required 23 label checks covering 22 distinct labels:
Bukhari 735 is required by both a cross-madzhab row and a chain row. The five
quotation traps were absence-checked; the kitab trap was checked against the
source-type inventory.

## Scope limits

- No new answer row is unverified: all 23 new answer-row citations resolved in
  the staging corpus. The six refusal rows carry no required citation by
  design, including the kitab trap.
- No new groups were added to the owner-signed matn-identity map. The new
  hadith requirements work through exact-address citation validity; a parallel
  chain of a new requirement will not widen citation validity until the owner
  signs a map group for it.
- No owner trap approval has been given.
- No eval or smoke run was executed, and no pass/fail result is claimed.
- The fixture remains `status: "v0-draft"`. The contract admits only `v0-draft`
  or `canonical`; changing that vocabulary is out of scope for this slice.
