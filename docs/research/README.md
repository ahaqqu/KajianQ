# Research: accurate answers with traceable evidence

This directory is a research notebook, not a specification. It records what we read,
what we measured, and what we propose — so that a rewrite can be argued from evidence
rather than from taste. Nothing here is binding until it becomes an ADR and lands in
`SPECS.md`.

## The problem, stated precisely

The product promise is an answer a reader can verify: every claim traceable to a
passage, every passage cited by an address a person can open. Measured against the
Golden Set on the deployed system, 21 questions produce these failure classes:

| class           | example                                                                                                                  | what is actually wrong                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **identity**    | the question needs a specific verse or hadith the dense index ranks thousands deep (`QS. 42:11` at rank 5,352 of 42,511) | the address is not in the retrievable text; no similarity function can score it    |
| **vocabulary**  | a doctrine question does not share a lexeme with a short formulaic verse                                                 | representation: the row does not contain the words the question uses               |
| **contract**    | the answer cites a parallel narration of the same report; the gate rejects it for not being the exact address            | the evaluation encodes one address where the corpus offers several valid evidences |
| **calibration** | the required evidence is retrieved and the draft refuses anyway                                                          | behaviour, not retrieval                                                           |

The rewrite must address all four. A better embedder alone addresses none of them.

## What is in here

| file                                                                 | what it establishes                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`retrieval-evidence.md`](retrieval-evidence.md)                     | what the literature says about Arabic retrieval, contextual representation, hybrid fusion, rerankers; which options are supported and which are traps |
| [`answer-attribution.md`](answer-attribution.md)                     | how to define traceability so it can be checked: evidence units, equivalence relations, quote fidelity, a gate that stays strict                      |
| [`agentic-probe.md`](agentic-probe.md)                               | our own measured probe: a tool-using model reaching evidence that single-shot retrieval misses, and where it fails                                    |
| [`proposal-v2.md`](proposal-v2.md)                                   | the proposed architecture, the experiments that would falsify it, cost and risk                                                                       |
| [`experiments.md`](experiments.md)                                   | E1–E10: what we measured, including two probes whose first run measured the harness rather than the system                                            |
| [`decision-brief.md`](decision-brief.md)                             | one page: the five settled facts, the four decisions, the recommended order, and what each one buys                                                   |
| [`../../research/agentic-probe.py`](../../research/agentic-probe.py) | the probe harness, so the measurement can be repeated                                                                                                 |

## Method

- Primary sources for every number, with a URL. Numbers that a review pass reported but
  this notebook did not re-derive are marked **reported**, not asserted.
- Our own measurements are labelled **measured**, with the command or transcript that
  produced them.
- Claims that do not transfer to a 42.5k-passage classical-Arabic corpus are marked as
  such. Almost every published number was obtained on English web text.
- No recommendation is made from a number alone: each carries the mechanism it assumes
  and the observation that would falsify it.

## Status

Twelve experiments have run, the last one end-to-end over the whole Golden Set: the proposed
architecture selects the required evidence for 9 of 18 questions, quotes it faithfully in
68 of 69 cited spans, hedges when the evidence is missing — and answers confidently without
the required evidence in five cases, which is why the gate needs coverage as well as fidelity.
Three artefacts exist as tested code and none is wired into the pipeline: quote fidelity,
multi-shape query expansion, and evidence units. The expensive
half of the original plan — generated contextual headers — was falsified and dropped; the
address-and-name label prefix survived on Quran but has not been measured on hadith, where it
would mean re-embedding 42k rows of a paid corpus.

`decision-brief.md` is the ask: four decisions, in the order the measurements support. Nothing
here is binding until the owner accepts it and it becomes an ADR.
