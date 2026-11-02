# S3 grade source — decision brief

**Question.** Is there an accessible, legally usable source of per-chain (per-isnad)
grades _with grader attribution_, at useful coverage for the Bukhari chains, that can be
joined to the S2 chains without upgrading a grade?

**Answer: no. Killed on grader attribution.** One candidate meets every other term —
الجامع Hadith Knowledge Graph (HKG) is per-chain, CC BY 4.0, free, and covers ~75% of the
Bukhari slice unambiguously — but its 577,024 chain verdicts name no critic, and ADR-0066
refuses to render a grade without one. The sources that do name critics (Dorar,
Sunnah.com, fawazahmed0) grade hadiths, not chains; the first two are also access-gated.

Measured on 2026-11-02 against `hadith-kg.db` (SHA-256
`d5280843…15a6`, the same hash ISNAD-Bench declares as its source) and the archived
`sanadset.csv` (650,986 rows). No API, model, or paid account was used.

## Candidates

| Source                 | URL                                                                                               | Licence / terms                                                                                              | What is graded                                             | Grader named?          |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------- |
| **الجامع HKG**         | https://huggingface.co/datasets/emadjumaah/hadith-kg (code: https://github.com/emadjumaah/hadith) | Data CC BY 4.0 (HF card; attribution to Emad Jumaah, الجامع); code MIT; underlying 2017 dump not distributed | **Chain** (`sanads.matn`, one row per isnad)               | **No**                 |
| ISNAD-Bench / `isnad`  | https://zenodo.org/records/22132880                                                               | CC BY 4.0; package Apache-2.0                                                                                | Chain (derived weakest-link output)                        | No — derived           |
| Dorar al-Sunniyyah     | https://dorar.net (API doc article 389)                                                           | No open licence found; no reuse terms published                                                              | Hadith (one verdict per entry; `mohdith` names the critic) | Yes                    |
| Sunnah.com             | https://sunnah.com/api                                                                            | API key granted on request; texts per sunnah.com terms                                                       | Hadith                                                     | Yes                    |
| fawazahmed0/hadith-api | https://github.com/fawazahmed0/hadith-api                                                         | The Unlicense                                                                                                | Hadith (v1 source)                                         | Yes (per-grader array) |
| Sanadset (baseline)    | https://data.mendeley.com/datasets/5xth87zwb5/5                                                   | CC BY 4.0                                                                                                    | Nothing — no grade column                                  | —                      |

Dorar and Sunnah.com both returned HTTP 403 (Cloudflare challenge) from the research
host; Dorar's API is undocumented JSONP with a third-party wrapper documenting a
100-search/day/IP cap. Neither is a viable ingest path this pass even at hadith grain.

## What HKG actually contains (measured)

- 577,024 `sanads` rows, 44,524 distinct `hukum` sentences, 6 grade labels:
  صحيح 151,067 · حسن 186,493 · ضعيف 170,195 · شديد الضعف 41,860 ·
  متهم بالوضع 19,457 · موضوع 7,952.
- **No attribution.** 0 rows match an attribution pattern (`قال <scholar>:`,
  `حكم عليه`, `رواه <book>`). The 302 `قال` hits are internal wording ("ويقال…");
  the apparent scholar names are narrator nisbas (verified: "شعيب بن صفوان",
  "إسماعيل بن بختمير الذهبي"). The verdict is the source database's own isnad
  analysis, with the critic's name stripped.
- Grading is genuinely per-chain: within Bukhari, 770 of 1,320 multi-chain hadiths
  carry different grades on different chains.
- Bukhari: 8,795 sanads over 6,533 hadiths (numbers 1–7,031; 498 hadiths have no sanad).
  Sanadset's Bukhari slice is 6,977 rows, also numbered 1–7,031 with 54 gaps.

## Coverage and join (measured)

- 92.9% (6,483/6,977) of Sanadset Bukhari hadith numbers exist in HKG.
- **74.6% (5,203/6,977) sit on a hadith with exactly one HKG sanad** — no chain choice
  needed. On the 5,196 comparable pairs, chain length agrees within 1 for 99.4% and the
  first narrator overlaps on tokens for 85.5%. Grades there: 4,359 صحيح, 807 حسن,
  35 ضعيف, 2 شديد الضعف.
- Generalising: ≈4,180 of the pilot's 5,602 chains (74.6%), assuming the pilot subset is
  not biased; the pilot's own chain rows cannot be matched exactly without re-reading
  the CSV.
- The join key is not in the database: `narrator_chains.source_ref` is
  `sanadset:row:<index>`, so a join must read the CSV row → `Num_hadith`, then
  `(collection, no_inbook)`. Hadith number alone is ambiguous for the other 25% (most
  have several HKG chains), and token-level chain matching only reached 68.9% at a ≥60%
  narrator-match threshold, with demonstrated false negatives (Sanadset "أبو نعيم" =
  HKG "فضل بن عمرو"; "أبي إسحاق" = "عمرو بن عبد الله"). A real chain join needs the S2
  narrator catalogue, not string folding.

## One concrete sample — it maps, and that is the problem

Bukhari no. 1 (`sanadset.csv` row 519,703) carries the chain
الحميدي عبد الله بن الزبير → سفيان → يحيى بن سعيد الأنصاري → محمد بن إبراهيم التيمي →
علقمة بن وقاص → عمر بن الخطاب (length 6). HKG sanad 1 for Bukhari no. 1 has the same six
narrators plus al-Bukhari at position 0 (length 7), graded **صحيح** with
`hukum = "إسناده متصل ، رجاله ثقات ، رجاله رجال البخاري"`. The record maps cleanly and
the grade is usable — but it arrives with no scholar behind it, so ADR-0066 §1 makes
it unrenderable. This is the whole finding in one row.

## Null policy

`narrator_chains.grade` / `grader` stay NULL, everywhere, this pass. #30 verifies the
ADR-0066 §3 unread path (a chain-bearing passage with no stored row keeps v1's
rendering and shows no grade). No backfill from v1's per-matn grade (ADR-0012), no
copying a per-hadith grade onto chains, no silently derived grade.

## Deterministic vs LLM, cost

The candidate work is deterministic (SQLite + Arabic name normalisation + the S2
narrator catalogue). No model call is needed, no API key, no signup: **$0**. The only
non-determinism risk is the entity join, which is a correctness risk, not a cost one.

## Risks (if anyone proposes proceeding with HKG)

1. **Attribution is absent at the source**, not recoverable downstream; the `hukum`
   sentences look like a normalisation of classical critics' takhrij, with the name
   dropped. Guessing the critic from the formula ("إسناده متصل، رجاله ثقات" is
   al-Arna'ut's style) is inference, not provenance.
2. **Provenance is opaque**: a single author's 2026 build from an undistributed 2017
   `hadithdb` mongodump. CC BY 4.0 covers the compilation; it does not establish rights
   in the underlying verdicts. No domain reviewer: ISNAD-Bench's own card says so and
   flags its rank mapping.
3. **A wrong chain join silently attaches the wrong grade** — the exact trust failure
   ADR-0012 exists to prevent.
4. **Vocabulary mismatch**: six source classes vs our four (`mutawatir|sahih|hasan|dhaif`);
   collapsing شديد الضعف / متهم بالوضع / موضوع into `dhaif` is an ADR-0012 decision.
5. The source's own audit reports 6,351 broken hadith links and 8,309 unrepairable
   narrator mentions; quality is unaudited for our purpose.

## Recommendation

**No-go.** No source can verify #30's grade display today: per-chain grades exist
without a grader, and graders exist only for whole hadiths. #30 should ship the null
path and the brief should stop S3 from buying an unattributed verdict. The only path
that reopens this is an owner decision to rewrite ADR-0066 and accept an
institutional or derived grader after a sampled review — not recommended, and a
different, hard-to-reverse decision than the one this brief was asked to make.
**Default under silence:** grade/grader remain NULL; #30 verifies the null rendering.

**What would change the answer:** a per-chain export that carries the critic's name
(or the original 2017 dump with its `محقق` field), or a per-chain dataset whose licence
and provenance survive review at >70% Bukhari coverage.
