# Decision packet — #627: what each instrument change recovers, risks and costs

Status: pre-registered research brief, written before the first experiment. The experiment log is
[`627-experiments.md`](627-experiments.md); every claim below is carried into the final decision
brief (D1–D5) only after it is labelled **measured** or **reported**.

## The question as a claim

The #627 decision memo proposes five instrument changes: identity groups (D1), a Qur'an
verse-equivalence ruling (D2), a requirement set for `gs-v0-008` (D3), an address-recall policy
change for `gs-v0-016` (D4), and a concept lever for `gs-v0-007` (D5). The claim under test:

> **C1.** Each change recovers only the Golden Set rows whose recorded failure it targets, and
> together they take the set from 15/21 to 20/21 — without flipping any currently-passing row to
> fail, and without making a citation acceptable that is neither the required address nor a
> curated, stated equivalent of it.
>
> **C2.** `gs-v0-016`'s address half cannot be recovered by any of the five changes without an
> owner decision that changes what the address-recall metric measures, and `gs-v0-007`'s recovery
> cannot be measured locally by retrieval alone: the concept that selects the verse is absent
> from the corpus, so only a new curated path (or a production change) can reach it.

**Kill condition.** C1 is dead if any of these is observed: (a) a change, applied through the real
scorer, does not flip its target row; (b) a change flips the verdict of a row outside its target
set; (c) the corpus-wide count of newly-equivalent addresses exceeds the curated membership the
change names; (d) a recorded cause is refuted at head — e.g. a cited narration turns out not to be
the same report the requirement names.

## What settles it

- **Measured:** the real `citationValidity` and `citationAddressRecall` functions, the real
  identity parser/resolver, and the real grammar, run over the recorded cited/retrieved sets;
  read-only SQL against `kajianq` at `127.0.0.1:55432`; the corpus's own stored embeddings for
  exact-rank probes.
- **Reported:** the deployed runs' cited labels and fused sets. The traces of runs `5d47c85b`,
  `6888d711` and `42101c2c` were erased after their QA runs, so the verbatim lists in #627's
  audit (`6343245653`) are the inputs. Their **scoring** is measured; their **content** is
  quoted, not re-derived.
- **Not measurable locally:** whether a fresh production run cites the same labels (the fused
  set is unstable run to run, #376 `6331117608`), and whether a 007 concept bridge generalises.
  Those are marked as owner calls, not given invented numbers.

## Decisions this unblocks

D1–D5 in the #627 decision memo. This packet measures, for each: **recovery** (does the row pass
with the change?), **blast radius** (which other rows and which other corpus addresses change
verdict?), and **cost** (data, code, re-embed, ingest, reversibility).

## Budget and stop rule

At most 8 experiments, 90 minutes wall-clock, US$0.50 paid embedding spend. Stop at the cap and
write what is measured; a partial brief with limits is the deliverable.

## Pre-registered experiments

| id  | question                                                                | method                                                                                                                       |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1  | Are the six recorded causes true at head?                               | fixture + `doc_children` reads: address presence, matn/chain overlap, source types; address universe for blast radius        |
| E2  | Does D1 recover 006/016/017, and what else changes?                     | real validity scorer on recorded cited sets, current vs proposed map; corpus-wide equivalence pairs; replay-row blast radius |
| E3  | Does D2 recover 012, and what would "same names" admit?                 | real scorer with a Qur'an resolver; count of verses sharing the two names (naive rule) vs the curated pair                   |
| E4  | Does D3 recover 008, and at what cost to the contract?                  | real scorer/address recall with an any-of requirement; rows affected by the contract shape                                   |
| E5  | Does D4 recover 016's address, and what does the metric stop measuring? | address recall with identity fallback; which rows' address verdict flips                                                     |
| E6  | Can any retrieval-side lever reach `QS. 42:11`?                         | exact cosine rank over stored embeddings: verbatim question, concept expansion, quotation-shaped query; within-surah rank    |
| E7  | What is the combined verdict?                                           | 21-row matrix: recorded verdicts + each measured change, with interactions                                                   |
| E8  | Is the local harness trustworthy?                                       | the repo's recorded-run replay test, used as the known-case check before any number is believed                              |

## Harness honesty

No harness output is trusted until E8 reports a known case correctly. Every number in the log
carries the exact command that produced it. Where a cited set comes from a QA report rather than
a local trace, the entry says **reported input, measured scoring**.
