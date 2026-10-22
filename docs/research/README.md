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

Research complete for the two questions that blocked the design: how to represent the
corpus so the needed evidence is reachable, and how to check an answer's traceability
without loosening trust. Implementation is not started; `proposal-v2.md` orders the
experiments.
