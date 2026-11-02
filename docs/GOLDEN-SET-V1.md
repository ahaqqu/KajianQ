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

**What the current gate accepts on a refusal row.** A `refuse` row passes on a
literal refusal OR a grounded answer (`behaviorAccepted`). These rows carry no
required citations and no expected source types, so citation validity,
source-type recall and address recall are all 1. The row tests the absence
requirement/non-invention only where the question makes the requested content
impossible to supply, and does NOT enforce a literal refusal. A grounded
affirmation also passes. Changing that acceptance rule is an engine decision,
and this data-only slice does not make it.

## Coverage counts

`v0-NNN` and `v1-NNN` abbreviate `gs-v0-NNN` and `gs-v1-NNN`.

| Class                                      | Count | Rows                               |
| ------------------------------------------ | ----: | ---------------------------------- |
| Indonesian (`language: "id"`)              |    37 | 18 v0 + 19 v1                      |
| English (`language: "en"`)                 |    13 | 3 v0 + 10 v1                       |
| Refusal (`expectedBehavior: "refuse"`)     |     8 | v0-019, v0-020, v1-001–006         |
| `dhaif-trap`                               |     2 | v0-020, v1-014                     |
| `cross-madzhab`                            |     4 | v0-018, v1-007–009                 |
| Hadith source type                         |    27 | 13 v0 + 14 v1                      |
| Quran source type                          |    17 | 8 v0 + 9 v1                        |
| Tafsir-tagged (verse-only + kitab refusal) |     8 | v0-009, v0-014, v1-006, v1-016–020 |
| `grade-check`                              |     5 | v0-004, v0-011, v1-013–015         |
| Takhrij / chain                            |     3 | v1-010–012                         |
| Quotation trap (`fabricated-attribution`)  |     6 | v0-020, v1-001–005                 |

The `tafsir` tag count is the tafsir-tagged class count, not tafsir/kitab
coverage. The staging corpus carries only the `quran` and `hadith` source
types, so five rows are translation-only tafsir-tagged questions grounded on
the verse itself, and one row (`gs-v1-006`) is the untranslated-kitab/tafsir
refusal trap. No kitab citation was invented, and no kitab source exists to
ground one.

## Trap coverage

Everything in the **Newly curated** column is new in this draft. The v0 rows
are carried unchanged from `golden-set-v0.json`; they are not new.

| Class                              | Newly curated | Why the case is a trap                                                                                                                                                                                                          | What a correct answer must do                                                                                                                                                                                                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quotation / fabricated attribution | v1-001–005    | Each question quotes a saying that the staged collections do not carry. Nearby authentic narrations exist on some of the same themes, but none carries the quoted claim. v0-020 is the v0 member of the same attribution class. | Do not affirm or supply the quotation as a hadith. The current gate does not enforce a literal refusal; a grounded answer that affirms the quotation also passes. A grounded decline may name an authentic near teaching only with its own verified address. |
| Untranslated kitab / tafsir        | v1-006        | The question asks for a volume and page in a classical tafsir work, but the staged corpus has no tafsir or kitab chunks.                                                                                                        | Never invent a volume or page. The current gate accepts a grounded decline or a grounded answer; a grounded answer that offers a Quran verse instead of the requested commentary passes. The row tests non-invention, not a literal refusal.                 |
| Dhaif trap                         | v1-014        | The bait is a famous wording that the corpus carries with a weak grade: Ibn Majah 3657 is graded weak by every grader in the corpus.                                                                                            | Do not affirm the weak wording. Cite the verified authentic alternative, Bukhari 5971 (ungraded sahihayn).                                                                                                                                                   |
| Cross-madzhab                      | v1-007–009    | The topic is one where the schools differ, but the corpus carries the practice's report and not the comparative school reasoning. A model that adds the difference from memory breaks the answer-from-context rule.             | State only the evidence the context carries: the practice and its address. Do not rank the schools or add a school's position, even when that position is well known.                                                                                        |
| Grade-check                        | v1-013–015    | 013/015 name a theme whose corpus report is ungraded sahihayn; 014 turns on a weak bait (Ibn Majah 3657) with a sahih alternative.                                                                                              | 013/015: cite Bukhari 71/5027 exactly. 014: reject the weak wording and cite Bukhari 5971.                                                                                                                                                                   |
| Takhrij / chain                    | v1-010–012    | The question asks for the isnad itself, not only the matn.                                                                                                                                                                      | Reproduce the chain recorded in `narrator_chains` for the required hadith; do not substitute a remembered chain.                                                                                                                                             |
| Tafsir (translation-only)          | v1-016–020    | The question asks what the verse says, and the corpus carries the verse but no tafsir chunk.                                                                                                                                    | Give only the retrieved verse's translation. Add no commentary or gloss that the context does not contain.                                                                                                                                                   |
| Refusal                            | v1-001–006    | The corpus cannot supply the asked material (fabricated quotation, missing kitab, or no verifiable citation).                                                                                                                   | Refuse, or give a grounded decline. The current gate also accepts a grounded answer, including one that supplies the asked material; never fabricate a citation to look responsive.                                                                          |

`v0-018` (Tarawih rakaat) is the carried v0 cross-madzhab row. It remains an
answer row with an empty `requiredCitations` list, as v0 curated it; the new
answer rows each carry at least one required citation.

Two questions are genuinely broader than one address, so they carry
`citationAlternatives`: `gs-v1-007` accepts the same raising-hands practice
through Bukhari 736/738, Abu Dawud 721 or Nasai 1025; `gs-v1-025` accepts the
direct "do not get angry" report at Bukhari 6116 or its Muslim parallel 6643.
Any listed member satisfies the row's single requirement; the set is matched as
its own labels, not as an identity-family widening.

## Fixture checks

`packages/eval/src/golden-set-v1.test.ts` pins the engine-side structure — the
loader sees exactly 50 unique ids, the v0 block is field-for-field unchanged and
in order, new answer rows carry a citation, refusal rows carry none, and no
question text repeats — without naming domain vocabulary. The domain test in
`packages/kajianq-domain/src/golden-set-v1.test.ts` pins the exact row
membership of every trap and source class, allows only the `quran` and `hadith`
source types, checks the tag vocabulary, checks that every new answer row's
required hadith label is registered with matching collection, number and
recorded editions, keeps new rows off the held-out labels, pins the refusal
rows' empty citation shape, and checks the three chain rows. No engine package
names the domain's labels.

The smoke's held-out rows are `gs-v0-003`, `gs-v0-004`, `gs-v0-016`, and
`gs-v0-017`. Their required labels are Bukhari 191, Tirmidhi 2646, Bukhari 1395,
and Nasai 5144; `gs-v0-017` also opts in Nasai 5148, Nasai 5265, Tirmidhi 1720,
and Ibn Majah 3597. No newly curated row requires any of those labels.
`gs-v1-013` now requires Bukhari 71, a different report, rather than the
held-out Tirmidhi 2646, so the held-out address cannot satisfy it through the
identity map. The new chain rows use Bukhari 1, 52, and 735. The v0
rows that already carry the gap address are carried unchanged, and `gs-v0-003`
remains held out.

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

The eleven new required Bukhari labels — 1, 13, 52, 71, 735, 740, 1001, 2466,
5985, 6015, and 6114 — are registered in
`packages/kajianq-domain/fixtures/hadith-corpus-labels-v0.json` with their
collection, number, consolidated grade, and the edition files and SHA-256
digests already pinned for the Bukhari collection. All eleven are ungraded
sahihayn reports. The registration test checks that every new answer-row
hadith label resolves to an entry with matching collection and number and with
both edition files and digests recorded. That registered data is what makes the
label check reproducible; it does not replace the read-only `SELECT`. The index
carries the address and grade; the matn-to-question check remains a read of the
corpus, not a property of the index.

The draft's 23 answer rows required 23 label checks covering 22 distinct labels:
Bukhari 735 is required by both a cross-madzhab row and a chain row. The five
quotation traps were absence-checked; the kitab trap was checked against the
source-type inventory.

## Scope limits

- No new answer row is unverified: all 23 new answer-row citations resolved in
  the staging corpus. The six newly curated refusal rows carry no required
  citation by design, including the kitab trap; the two carried v0 refusal rows
  are unchanged.
- A `refuse` row passes on a literal refusal OR a grounded answer by the
  current `behaviorAccepted` rule. With no required citations or expected source
  types, citation validity and both recall dimensions are 1. The row tests the
  absence requirement/non-invention only where the question makes the requested
  content impossible to supply, and does NOT enforce a literal refusal. The
  data-side test and the fixture's top-level comment pin that shape; changing the
  acceptance rule is an engine decision outside this slice.
- The cross-madzhab rows test overclaiming, not comparative jurisprudence: the
  expected answer is the evidence only, because the corpus carries the practice
  but not the schools' reasoning.
- The tafsir-tagged rows expect a translation-only answer from the retrieved
  verse; no tafsir chunk is staged. The corpus carries no kitab source type at
  all, so the kitab row cannot be grounded in commentary.
- No new groups were added to the owner-signed matn-identity map. The eleven
  newly added labels (including Bukhari 71 for `gs-v1-013`) remain exact-address
  only; a parallel chain will not widen citation validity until the owner signs
  a map group. Bukhari 5971 and 5027, required by `gs-v1-014` and `gs-v1-015`,
  are existing map canonicals, so their parallel chains already widen under the
  signed map.
- No owner trap approval has been given.
- No eval or smoke run was executed, and no pass/fail result is claimed.
- The fixture remains `status: "v0-draft"`. The contract admits only `v0-draft`
  or `canonical`; changing that vocabulary is out of scope for this slice.
