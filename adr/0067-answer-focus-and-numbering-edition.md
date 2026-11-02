# ADR-0067: An answer leads with its primary matn, and a hadith number names its edition

## Decision

1. **The answer comes first, and the primary/strongest evidence leads.** Every
   answer states what the evidence says about the question directly, then places
   the primary or strongest narration ahead of its parallels.
2. **The full matn is quoted once.** The Arabic and its translation are
   reproduced for the primary/strongest narration only. A parallel narration of
   the same hadith — another collection, another chain, another route — is named
   compactly: collection, number, grade and grader.
3. **Completeness is unchanged.** Every chain and grade the evidence rules
   require stays named, the takhrij is still given, and no grade is ever raised;
   the rule governs presentation, never disclosure. The assembled context still
   carries every parallel, so nothing is hidden from the reader or the reviewer.
4. **A hadith number names its edition.** The citation sheet states that hadith
   numbers follow the corpus edition (`fawazahmed0/hadith-api`, derived from
   sunnah.com) and that other printed editions may number them differently. The
   caption renders on hadith citations only, because no other source carries a
   hadith number.
5. **The dataset notice records the same provenance.** The corpus attribution
   keeps its existing sunnah.com credit and adds the numbering-edition sentence.

## Why

A check of the answer path produced answers that were accurate and unusable: one
had every parallel narration quoted in full with Arabic and isnad, so the most
famous hadith the question was about arrived last; another catalogued its
parallels instead of answering. Length is not falsity, but an answer that
catalogues its evidence hides its own claim and leaves the reader unable to tell
which evidence governs. The product's trust posture depends on the primary
evidence being the one the reader sees first.

A hadith number without its edition has the same defect in miniature: a reader
checking another printed collection may not find the number at all, and a
citation that cannot be checked is not a transparent citation.

The alternative — a citation cap — was rejected because it would drop chains the
evidence rules require and turn a presentation defect into an evidence defect.
Compressing the repeated text keeps every disclosure.

## Consequences

- Both language prompts carry the rule after the chain rules, and it states
  explicitly that it does not relax them.
- A prompt contract test pins the instruction against several parallel
  narrations; the assembled context keeps every parallel's label and grade.
- The caption is externalized Indonesian and English UI copy; the citation
  contract, the trace vocabulary and the API are unchanged.
- **Revisit when** evaluation shows the model still catalogues under the rule,
  or when a per-matn identity lets assembly order the primary by grade rather
  than by retrieval score.
