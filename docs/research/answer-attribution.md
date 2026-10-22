# Answer attribution: making traceability checkable

The product promise is that every claim is traceable to a passage and every cited address
can be opened. This note defines what "traceable" has to mean for that promise to be
checkable, and what a release gate can honestly enforce.

## 1. The current contract conflates three different relations

The Golden Set stores one requirement per question as a single citation string
(`HR. Bukhari no. 1108`). The gate then asks that string to answer two incompatible
questions at once:

- _is this evidence reachable?_ — a retrieval property;
- _is this exact row the evidence the answer used?_ — a citation property.

They disagree by design in the code. `citationValidity` already accepts a curated matn
identity (a parallel narration of the same report); `citationAddressRecall` explicitly
refuses one — "recall asks for the exact address, so a parallel narration does not count
here". Four of the six measured failures sit exactly on that seam: the answer cites a
narration that says the same thing under a different chain, and the gate calls it a miss.

That is a **contract defect**, not a checker defect, and no better checker fixes it.
Separating "is the claim supported by the cited evidence" from "is this the address the
curator had in mind" is not novel: only the first is a trust property
([Jacobs & Wallach, 2021](https://arxiv.org/abs/1912.05511)). The over-refusal row is a
third construct — behaviour calibration — and folding it into the same pass/fail makes
the system look worse than it is.

## 2. Evidence units replace address strings

Represent a requirement as an **evidence unit**, not a label:

```ts
type EvidenceUnit = {
  unitId: string; // stable id, e.g. "unit.bukhari.191.matn"
  kind: "quran" | "hadith" | "tafsir" | "fiqh";
  members: CitationRef[]; // >=1 corpus rows that carry this evidence
  canonical: CitationRef; // the address shown to readers by default
  textHash: string; // hash of the canonical matn/verse text at curation time
  status: "draft" | "canonical";
};
type CitationRef = { label: string; address: string; locator: SpanLocator };
```

Three relations, never merged:

1. **Address equivalence** — deterministic, grammar-level: `2:255` is inside
   `2:255-256`; `no. 3756.2` folds into `no. 3756`. Total, free, no model.
2. **Identity equivalence** — curated and versioned: the same matn under another chain, a
   verse and its immediate parallel. Only a curator may assert it, because it is a claim
   about the corpus, not about strings. The existing identity loader already enforces
   disjoint groups and one canonical label; what it does not enforce is that **every
   member exists in the corpus snapshot** — that check is missing and must be added.
3. **Support entailment** — model-scored, one-directional, per claim. It may _verify_ a
   member of a unit; it may never _widen_ relations 1 or 2.

An unmapped label remains its own singleton (fail-closed). Every accepted equivalence is
**rendered**: the trace records the unit, the matched member and the reason
(`address-identical` vs `curated-identity`), so a reader can see that the answer cited a
parallel narration rather than the canonical address.

## 3. What the gate computes

| metric             | definition                                                                                        | deterministic?      | role                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------- |
| `unitRecall`       | units satisfied by the retrieved evidence                                                         | yes (curated units) | gate: must be 1                           |
| `quoteFidelity`    | fraction of cited sentences whose attached quote is a **normalized substring** of the cited chunk | yes                 | gate: must be 1                           |
| `claimSupport`     | quote → claim entailment, tiered                                                                  | model               | gate at a claim-level rate, never per row |
| `addressPrecision` | exact address match                                                                               | yes                 | diagnostic only                           |

`quoteFidelity` is the load-bearing check, and it is the one nobody usually builds: it
turns "the model says it used this passage" into "these characters are in this passage".
It is monolingual (an Arabic quote against an Arabic chunk), which sidesteps the
cross-lingual weakness of every entailment model cited below. It also catches the
failure our probe observed: a model quoting an address it only saw in a truncated search
snippet.

## 4. Verification stack

| tier | check                                                                                                                       | cost                                | failure mode                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| 0    | citation exists among retrieved chunks; address parses; span resolves; **quote is a normalized substring**; weak-grade flag | ~0                                  | Arabic normalization over-folds (diacritics, alef/ya/ta-marbuta)           |
| 1    | cross-encoder entailment (quote → claim), MiniCheck/AlignScore class, 355–770M                                              | one forward pass per cited sentence | cross-lingual gap (Indonesian claim, Arabic quote); negation/numeral swaps |
| 2    | rubric judge on (quote, claim) only, different model family, low-margin cases                                               | 10–20% of answers                   | self-preference, verbosity bias, ~80% ceiling                              |

Tier-1 evidence: [MiniCheck](https://arxiv.org/abs/2404.10774) reports GPT-4-level
fact-checking with a 770M model at ~400× lower cost; [AlignScore](https://arxiv.org/abs/2305.16739)
matches ChatGPT-based metrics with 355M parameters across 22 datasets (**reported**).
The ceiling is real: [AttributionBench](https://arxiv.org/abs/2402.15089) reports ~80%
macro-F1 even fine-tuned (**reported**). No checker is a truth oracle, so the gate's
deterministic tiers must carry it and the model must only judge what resists determinism.

## 5. What the numbers say about how much can be trusted

- [ALCE](https://arxiv.org/abs/2305.14627): best systems lack complete citation support
  50% of the time on ELI5; citation **recall** is the gate-worthy half, precision is
  diagnostic (**reported**).
- [Commercial engines audited](https://arxiv.org/abs/2304.09848): 51.5% of generated
  sentences fully supported, 74.5% of citations support their sentence (**reported**).
- [FActScore](https://arxiv.org/abs/2305.14251): ChatGPT 58% of atomic facts supported
  (**reported**) — a useful calibration for "how good does a good system look".
- [Generation-time vs post-hoc citation](https://arxiv.org/abs/2509.21557): a consistent
  coverage/correctness trade-off; retrieval-centric post-hoc citation is the recommended
  first step for high-stakes settings (**reported**).

None of these numbers transfer to Indonesian claims over Arabic quotations; they set
expectations, not thresholds.

## 6. Release gate

- **Trap integrity**: zero tolerance. Every fabricated-source or weak-grade trap is
  refused, every answerable row answered. Never averaged into a rate.
- **`unitRecall` = 1** on answerable rows.
- **`quoteFidelity` = 1** (deterministic, so no tolerance is defensible).
- **`claimSupport` ≥ 0.98 of claims** (≈5 per answer, so n≈100) with Wilson lower bound
  ≥ 0.90 — never per row, where n=21 cannot support that bound
  ([ARES](https://arxiv.org/abs/2311.09476) shape: few labels, calibrated intervals).
- **Over-refusal ≤ 1 row**, reported per tag.
- **`addressPrecision` ≥ 0.85**, diagnostic.

Held-out design: freeze ~30% of rows, never used for prompt iteration; split by
**evidence-unit family**, not by row, or the same verse sits on both sides and the gate
measures memorisation; write each trap before the fix it tests; re-baseline on every
corpus snapshot; rotate a private slice, since public rows get optimised against
([leaderboard effects](https://arxiv.org/abs/2504.20879)).

**What would make the gate dishonest:** accepting equivalence without auditing the unit
map; tuning prompts on the rows the gate scores; adopting a tier-1 model whose
false-accept rate was never measured on adversarial quotes; averaging a zero-tolerance
trap; letting the generator's own family judge it
([self-preference](https://arxiv.org/abs/2404.13076)); reporting a pass rate without the
list of failing rows.

## 7. The experiment that decides whether equivalence weakens trust

For every cited sentence in the Golden Set, build four conditions:

1. the true quote;
2. a parallel-narration quote — same matn, other chain (must satisfy identity, must fail
   address);
3. a topically identical wrong-address quote (adjacent verse, another hadith on the same
   theme);
4. a minimal-edit adversarial quote (negation, numeral or name swap).

Run tiers 0–1 blind and record false accepts. **Decision rule:** if tier 1 accepts any
(3) or (4) item, it cannot gate support; the gate rests on `quoteFidelity` plus curated
units and the model becomes a diagnostic. If it rejects all of them while accepting ≥20/21
true quotes, equivalence is safe to accept and the model earns a gate seat.

**Measured** ([`experiments.md`](experiments.md) E4, six claims × four conditions): true
6/6 accepted, parallel 5/6, wrong-address 0/4… 0/6 rejected, adversarial **1/6 accepted** —
a negation flip passed. The rule therefore fires: the model tier is a **diagnostic**, not
a gate.

## 8. Open questions

- Is exact address a product requirement, or should the UI say "same report, different
  chain"? That is an owner decision, and the contract above supports either answer.
- What does curating unit membership cost at 42k passages, and who verifies it?
- Does any multilingual entailment model survive Indonesian-claim/Arabic-quote at an
  acceptable false-accept rate? Unmeasured.
- Does Arabic normalization ever change meaning here (diacritics on a single word)?
