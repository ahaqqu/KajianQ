---
name: research
description: Deep research before code when the mechanism is unknown — a bug that survived two fixes, a technology the repo has never used, or a design choice that needs evidence rather than opinion. Carries the falsifiable brief, the reported-versus-measured rule, prototype harnesses that prove themselves before they are believed, the experiment log with stable IDs, and the decision brief that ends research. Reach for it when an implementer has failed twice on the same symptom, when a decision needs a number nobody has measured, or when no one can state the failure's mechanism.
source: project
---

# Research

A hard problem fails in two directions, and they cost differently. A guess produces a patch that
silences the symptom, and the bill arrives later as a regression nobody can explain. Unbounded
research produces notes nobody can act on. This skill is the discipline between them: a bounded
investigation that ends in a decision the manager can take.

The `researcher` role (`.zcode/agents/researcher.md`) runs it. The manager dispatches it when the
mechanism or the evidence is missing; the researcher never ships production code.

## 1. Write the brief before you search

A research brief is one screen, written before the first search, and it changes what you find:

- **The question as a falsifiable claim.** Not "why is retrieval bad" but "queries that name a
  book and a number fail because the address is not in any retrievable text". A claim can be
  killed; a topic cannot.
- **The kill condition.** The observation that would refute the claim, stated in advance. If you
  cannot name one, the claim is not a hypothesis yet — and then do not start measuring: name the
  observation that would surprise you, or narrow the claim until one exists. When neither is
  possible the claim is not ready: return the brief to the manager with the claim restated as a
  hypothesis and what is missing. A brief that cannot fail cannot end.
- **The decision it unblocks**, by name: the ticket, the gate, the approach choice.
- **What evidence settles it** — a measurement on this corpus, a document that states a
  guarantee, or a prototype that behaves one way under a test.
- **The budget**: wall-clock, spend, and the maximum number of prototypes. Stop rules are decided
  when stopping is cheap, not when it is expensive.
- **The deliverable**: a decision brief with recommendations, not a pile of findings.

**The artifact contract.** The brief, the experiment log and any prototype are committed on the
`research/<slug>` branch at the paths the dispatch names: the manager's task text names the brief's
file, the log's file, the prototype directory and, for a bug, where the failing test lives. This
skill does not choose them — it cannot invent repository structure, and two researchers left to
their own layout produce two branches the manager cannot read. Commit the brief before the first
experiment and append to the log as each experiment ends; a result that lives only in the final
report is not retrievable next month.

## 2. Separate what is reported from what you measured

Two streams feed a research answer, and they carry different weight:

- **Reported** — papers, vendor documentation, an open-source implementation's source, a forum
  thread. It tells you what to try and what has failed for others. It is a lead, never a verdict.
- **Measured** — a number produced by a harness you ran, on the corpus this repo actually serves.

Label every claim with its stream in the write-up. A citation that transfers poorly is worse than
no citation: technique papers report on English, general-domain, well-formed text, and a corpus of
classical Arabic with isnads is a different distribution. Record what the source measured, on what
data, and whether that data resembles ours; "the paper says so" is not evidence for a decision.

Search with the mechanism in mind, not the symptom: the symptom's vocabulary ("answer is wrong")
finds other people's symptoms, while the mechanism's vocabulary ("address not in retrievable
text", "lexical mismatch", "ranking fusion") finds the technique that moves it.

## 3. Build a harness that can be wrong, then prove it right

A prototype that reports numbers has one job before its numbers count: show that it reports a known
case correctly. Feed it a case whose answer you already know — a query that must find a known row,
a quote you inserted on purpose, a score you can compute by hand. If the harness fails the known
case, it is the bug, and an investigation that skips this step measures its own mistakes.

The trap is subtle because the wrong harness produces plausible numbers. A rank read as an index
gives a tidy table that means nothing. Before trusting a surprising result, verify one row by hand
— open the database, print the chunk, read the answer — and only then explain the aggregate.

Keep the harness small enough to re-run: one command per experiment, deterministic inputs, a fixed
sample when the corpus is large. A harness that cannot be re-run makes its results unverifiable,
which is the same as not having them.

## 4. Enumerate hypotheses, not parameters

The instinct on a hard problem is to tune the knob in front of you. The better move is to list the
mechanisms that could produce the symptom — the address is absent from retrievable text; the
vocabulary is not shared; the fixture encodes one of several valid answers; the evidence is present
and the prompt refuses anyway — and design one measurement that separates them.

Diversity beats cleverness. Four differently shaped attempts (a paraphrase, a hypothetical answer
passage, a quote-shaped passage, a rewritten query) move more rows than one attempt tuned four
times, because the shapes fail differently. When a result is a wash, that is data: say so plainly
and move to the next shape rather than fitting the one that nearly worked.

## 5. Keep an experiment log with stable IDs

The log is the spine of the eventual brief, and negative results are its most reusable part. One
entry per experiment, appended to the file the dispatch named, never rewritten:

```text
E<n> — <one-line question>
Setup: what ran, on what data, in what configuration
Command: the exact invocation
Result: the table, including the cases that did not move
Verdict: confirmed | refuted | inconclusive — and what the next experiment is
Cost: spend and wall-clock
```

Stable IDs let the brief cite evidence in one token (`E7`), and let a later investigator check
whether a conclusion still holds. An experiment with no result is still an entry: "the probe
returned nothing" is a finding about the probe.

## 6. Distrust surprising results in both directions

A result that is too good is usually a harness bug; a result that is too bad is usually a sample
that cannot discriminate. Before writing either down, ask:

- Would this result be different if my assumption were false? If not, the experiment tests nothing.
- Did the sample contain the case the claim is about? A fixture set that lacks the failure cannot
  demonstrate the fix.
- Does the aggregate hide a bimodal reality? Ten of twelve improved and two collapsed is not "a
  modest gain" — name both effects.

Report the losing cases by ID. A brief that cites only its wins is advocacy, not research.

## 7. End with a decision brief

Research ends when the manager can decide. The brief is numbered decisions, each one page-short:

```text
D<n> — <decision> (<recommended option> or "hold")
Evidence: E3, E7 — one line each on what they showed
Why it matters: the consequence of getting it wrong
Default if nobody rules: what happens under silence
What would change the answer: the measurement or event that reopens it
```

Every decision carries a default under silence, so no owner answer is a blocking requirement for
progress on unrelated work — and so a decision postponed is visibly a decision, not an oversight.
A recommendation without a default is a demand; a default without a recommendation is indecision.

## 8. Hand back; do not take over

The researcher's output is a brief, an experiment log, and — when the subject is a bug — a failing
test that pins the mechanism. It is not a production change, not a gate change, and not a merge.

When the finding is a fix, the manager dispatches implementation carrying the brief, and the
implementer owns the code. When the finding is a decision, the manager relays the brief and the
default. When the finding is "the harness was wrong", say so in the log and re-run: that entry is
the most valuable one in the file.

Before the manager acts on a brief, it verifies at least one of the numbers itself. A research
result that cannot be reproduced by its reader is a rumour with a bibliography.

## Anti-patterns

- **A topic instead of a claim** — "investigate citation quality" cannot succeed or fail, so it
  cannot end.
- **A paper as a verdict** — reported technique, unmeasured on this corpus, presented as a plan.
- **A harness trusted on its first output** — the known-case check skipped, the tidy table wrong.
- **Tuning where hypotheses were needed** — the same knob at five settings, reported as five
  experiments.
- **The log that only records wins** — the failed shapes are exactly what the next investigator
  needs.
- **The brief with no default** — every option awaits an owner who has not been asked a question
  they can answer.
