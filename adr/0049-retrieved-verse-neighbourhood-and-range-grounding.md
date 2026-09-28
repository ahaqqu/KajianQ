# ADR-0049: Retrieved-verse neighbourhood expansion, and a range citation's address list

## Status

Accepted (2026-09-28, #274). Owner-decided direction. It **amends ADR-0045**
(a second trigger for the same deterministic expansion) and **completes the
follow-up #264 recorded on `DASH_JOINED_NUMBER_TAIL`** ("split the compound at
the comparison site, require each address grounded"). It does not relitigate
ADR-0013 (dual-track retrieval), ADR-0036 (the embedding gate), ADR-0008/0027
(the `RagStore` seam and its Effect signature), ADR-0021 (the runner owns the
trace), ADR-0009 (cost discipline) or ADR-0046 (trap acceptance). No vendor
call, no paid dependency, no re-ingest, no migration.

## Context

- **The incident.** `Staging` smoke on `af70fae` (eval run
  `4bfc315f-c537-4744-b5e1-63ddc277fa65`, question `gs-v0-001`, trace
  `3c87fc7a-4c75-476a-a264-b8dfff9ac40c`) refused with
  `ungrounded_citation` — "citation(s) not present in retrieved context:
  QS. 3:1-2". The generator cited the **range** `QS. 3:1-2`; the retrieved set
  held `QS. 3:2` (and `QS. 2:255`, the question's actual required citation)
  and **not** `QS. 3:1`. The gate withheld the answer and the user saw the
  canonical refusal for an answerable question.
- **The defect is upstream, not in the gate's rule.** A draft citing a verse
  that was never retrieved must be withheld (SPECS §2.2's #1 control). The
  model _extended_ a retrieved verse (`3:2`) into a range whose head it was
  never given. Fixing the retrieval is the cause-side fix; loosening the gate
  would be the symptom-side one.
- **The gate could not ground a range at all — measured, not inferred.**
  `DASH_JOINED_NUMBER_TAIL` (chat-citation-grammar, #264 item 4) keeps a
  dash-joined compound **whole**, so before this ADR
  `validateCitations("… QS. 3:1-2 …", [chunk("QS. 3:1"), chunk("QS. 3:2")])`
  returned `ungrounded: ["QS. 3:1-2"]`: a range was refused **even when every
  address it names was retrieved**. #264's own comment on the constant records
  the follow-up — "split the compound at the comparison site, require each
  address grounded" — and its test pinned the cost as accepted-for-now. #276's
  QA probe B2 proved that cost live on the deployed surface: `QS. 2:255—256`
  was refused while its head `QS. 2:255` _was_ retrieved.
- **What the generator actually does — 2 days of `answer_traces` (read-only,
  2026-09-26 → 2026-09-28).** 186 traces; 63 refusals; **9** refusals with
  `trigger: "ungrounded_citation"`, carrying **27** cited-but-ungrounded
  labels. Of those 27: **26 are hadith addresses whose trailing colon
  (`HR. Bukhari no. 4704:`) the pre-#266 build did not reduce** — the current
  grammar grounds every one of them against the same retrieved set, so they
  are already closed by #266 and are not this ADR's subject. **1 is a Quran
  range** (`QS. 3:1-2`), and the current gate still refuses it. So the
  observed rate of "the draft names an address the context does not hold" on
  the current build is **1 in 186 drafts**, and it is a _range extension_, not
  a fabricated address.
- **A prompt change is not justified by that measurement.** The rate is 1/186,
  the class is repaired deterministically by making the address present, and
  nothing in the sample shows a systematic prompt-level failure a wording
  change would address. The one class prompt guidance could plausibly move —
  "cite exactly the retrieved address" — is exactly the behaviour the
  deterministic read now _guarantees_ rather than requests. Recorded as a
  revisit trigger, not implemented.

## Decision

1. **The expansion is extended from "the question named a surah" to "a
   retrieved chunk is a verse".** When the retrieved set (fused hits and
   ADR-0045's surah-scope chunks) holds a verse, that verse's **ordinal
   neighbours** in its own parent join the context — the same deterministic,
   structural, vendor-free read ADR-0045 established, with a second anchor.
   The purpose is that a range the generator writes _over verses it was
   actually given_ is genuinely in context, so the gate can keep its
   strict-whole rule and still let an ordinary citation form pass.
2. **The read is anchored on the retrieved child ids, not on a derived
   ordinal.** `RagStore.listDocChildNeighboursByChildIds(anchorIds,
{ radius, limit })`: the anchors are the opaque ids the caller already
   holds, the adapter derives each anchor's parent and `ordinal` **from the
   row itself**, and returns only that anchor's neighbours (never the anchor),
   ordered by the anchor's position in the caller's array and then by
   `ordinal`. The store learns nothing about Quran — no domain term, no
   citation parsing, no metadata key — and the window cannot be mis-anchored,
   because there is no second source of truth for a chunk's position. The
   caller's array order is the priority order, so the cap truncates the
   _least important_ windows rather than an arbitrary subset.
3. **Bounded twice, and configured at the composition root.**
   `DEFAULT_NEIGHBOUR_RADIUS = 1` (verses on each side of an anchor) and
   `DEFAULT_NEIGHBOUR_CAP = 12` (chunks the expansion may add, matching
   `SCOPE_EXPANSION_CAP`'s scale); `apps/api` reads
   `NEIGHBOUR_EXPANSION_RADIUS` and `NEIGHBOUR_EXPANSION_CAP` (non-negative
   integers; malformed = typed config failure), and **either value `<= 0`
   disables the expansion**. The cap is not decoration: uncapped, a radius-1
   window would have added **p50 46 / p90 63 / max 74** chunks on the 130
   traces that hold Quran anchors — roughly doubling the prompt. Capped at 12
   the expansion can never become the bulk of the context.
4. **The range citation names a list of addresses, and every one must be
   present.** A `CitationGrammar` declares `addressesOf(match)` — the
   addresses a match **names**. The Quran grammar declares that
   `QS. 3:1-2` names `QS. 3:1` **and** `QS. 3:2`, so the comparison form
   grounds only when both are in the retrieved labels. The **display** form is
   unchanged: the candidate label stays the range as written (`QS. 3:1-2`),
   so the refusal reason, the reviewer pre-gate's claim spans and the
   user-visible citation text keep naming what the draft named. A grammar that
   declares no address list (the hadith grammar today) is untouched: its
   dash-joined compound stays the opaque whole it was, and refuses.
5. **Traceable as its own retrieval path.** Added chunks carry
   `origin: "verse_neighbours"` — distinct from the fused refs (no label) and
   from ADR-0045's `scope_expansion` — so a trace reader never has to infer a
   path from rank. A typed `neighbour_expansion` event records the **anchor
   ids actually read, in priority order**, plus `returned`, `cap`, `radius`
   and `truncated`, so every added chunk resolves to a read that produced it
   (same parent, within `radius` ordinals of a named anchor) instead of to
   "the expansion, somehow".
6. **Dedup against everything already in context.** A neighbour already
   produced by the fused tracks or by the surah-scope expansion is not added
   twice, and `returned` counts only what was actually added.

## Rationale

- **Cause-side is the only fix that does not trade safety for fluency.**
  The gate's rule is the product's #1 control; a range asserts grounding for
  every address it names, so a partially-retrieved range must not pass. Making
  the addresses present keeps both properties at once: the user gets the
  answer, and the gate still cannot be talked into grounding a verse nobody
  retrieved.
- **A retrieved verse is a deterministic anchor; a named surah was an
  inferred one.** ADR-0045's detection is a string match on the question, and
  its failure mode is a question that names nothing (no expansion). Anchoring
  on the retrieved rows has no detection step at all: what is in the context
  is exactly what the read is keyed on, and a chunk that is in the context is
  by construction a chunk the model may cite.
- **The cap is what makes the widening affordable, and the ordering is what
  makes it useful.** Truncation has to be a decision, not an accident: with
  ~23 retrieved verses from as many surahs, p50 46 candidate neighbours exist
  and only a bounded few can enter. Ordering by the anchor's fused position
  spends the budget on the neighbourhood of the best-ranked evidence — the
  evidence the answer is most likely to cite — and makes the truncated set a
  function of the run's own retrieval order rather than of a uuid sort.
- **Fidelity, not relaxation, at the gate.** Today's comparison form
  implements "the whole label must appear verbatim", which is _neither_ the
  stated rule nor a safe approximation of it: it refuses a fully-retrieved
  range, which converts a legitimate citation form into user-visible
  stonewalling. The declared address list makes the implementation say what
  the rule says. The safety direction is unchanged and strictly tighter than
  both rejected options.

## Alternatives considered

- **Prompt guidance only ("cite exactly the retrieved address").** Rejected as
  the fix, on the measurement above: 1 extension in 186 drafts, and the
  requested behaviour is exactly what a deterministic read now guarantees.
  Leaving the answer's fate to the model obeying a prompt is the
  nondeterminism ADR-0045 already rejected for the same class of problem.
  (A prompt change would also not close #276 B2's fully-retrieved range.)
- **Head-first matching** (`QS. 3:1-2` grounds on `QS. 3:1` alone). Rejected:
  a range names what it names, and dropping the tail asserts grounding for a
  verse nobody retrieved. It is also the _pre-#266_ behaviour that reopened
  the hole #264 closed.
- **Any-member matching** (a range grounds if any verse in it was retrieved).
  Rejected for the same reason, with a larger hole: a 40-verse range would
  ground on one retrieved verse.
- **Re-curating `gs-v0-001`'s fixture.** Rejected: the question is answerable
  and its required citation (`QS. 2:255`) _was_ retrieved in the failing run;
  hiding the range in the fixture removes the signal instead of the defect.
- **A gate rewrite that splits any dash-joined number at the comparison
  site.** Rejected as a regex hack: splitting is address semantics, and only
  the grammar that owns an address knows whether a dash joins two of them or
  is part of one token. A comparison-site pattern would also silently
  re-interpret the hadith compound, whose range form is not declared.
- **An ordinal-anchored window** — pass `(parentSourceKey, anchorOrdinal)` and
  let the domain pack derive the ordinal from the chunk's `ayah` metadata.
  Rejected: it makes the chunk's _position_ a second source of truth, and a
  wrong derivation adds the wrong verses **silently** — the exact failure mode
  this work exists to prevent. The id-anchored read derives the position from
  the row the retrieval already returned.
- **Reusing `listDocChildrenByParentSourceKey`.** Rejected: it is
  ordinal-ascending from the parent's start, so a verse at ordinal 255 of 286
  would receive the surah's _opening_ verses — a window that cannot anchor,
  and one that would grow the context with chunks unrelated to the citation.
- **An uncapped neighbour window.** Rejected on the measured p50 46 added
  chunks (~doubling the prompt), against SPECS §5's cost posture.
- **Expanding neighbours only of the top-ranked verse / only backward
  neighbours.** Rejected as overfitting: #274's incident extends a range
  _backwards_ to its head, #276 B2's extends _forwards_ to its tail, and the
  anchor-priority ordering already handles both without a direction rule.
- **A new paid call (embedding or LLM) to widen recall.** Rejected: ADR-0009
  and ADR-0034 forbid unrecorded spend, and the reference is already stated by
  the retrieved row — this is a lookup, not an inference.

## Consequences

- **A range citation now grounds when — and only when — every address it
  names is in the retrieved context.** `QS. 3:1-2` passes with `QS. 3:1` and
  `QS. 3:2` in context; it still refuses with only the head, with only the
  tail, and with a fabricated second address. A single fabricated verse still
  refuses (unchanged). The behaviour change is visible to the user as an
  answer where there used to be a stonewall, which is the point.
- **Context grows on Quran-bearing queries, bounded by the cap.** Measured on
  the same 2-day window: with `radius = 1, cap = 12` the expansion adds up to
  12 chunks per affected query (p50 46 candidates before the cap), and its
  prompt cost is reported in the PR with the token delta the assembler
  renders. For a query with no retrieved verse the expansion issues no store
  read at all.
- **One more store read on the hot path, on Quran-bearing queries only.** It
  is a single batched, indexed query regardless of the anchor count (not one
  round trip per anchor), and it returns no anchors, so its row count is the
  cap.
- **The trace contract grows by one event kind.** Additive
  (`neighbour_expansion`), so persisted traces stay readable per ADR-0007's
  forward-compatibility rule; the contract test parses a trace with the new
  event and a pre-change one without it.
- **A failure on the neighbour read is fail-closed, uniform with the fused and
  scope reads**, wrapped by `toStageError("retriever", …)`. Degrading to the
  fused set would answer with a context that lacks the addresses the model
  tends to cite, i.e. reproduce the refusal this ADR exists to remove, behind
  a 200 response.
- **The eval report's `expansion` block keeps its ADR-0045 meaning** — the
  **surah-scope** path only. The neighbour path is visible on the trace event
  and on each chunk ref's `origin`; counting it inside `expansion.chunks`
  would silently redefine a metric ADR-0045 already published. Recorded here
  because the alternative (fold both into one number) was considered and
  rejected.
- **Three modules were at or over the 300-line agentic cap, so three
  same-subject splits landed with this change** — `chat-citation-spelling.ts`,
  `chat-citation-normalize.ts` and `chat-fusion.ts` — plus the retriever's
  companion barrel `chat-retriever-parts.ts` for the 5-import cap. Each split
  is a line-count move, not a new seam: the public surface is unchanged
  (`chat-citation-validator` re-exports the scan and the comparison form; the
  domain barrel re-exports the fusion arithmetic), and every subject keeps one
  owner.

## Evidence

- `packages/kajianq-domain/src/chat-citation-validator.test.ts` — the range
  matrix, pinned at the validator boundary: both addresses retrieved →
  `ungrounded` empty; head only → refuses; tail only → refuses; neither →
  refuses; a fabricated second address (`QS. 3:1-999`) → refuses; a single
  fabricated verse → refuses; the hadith compound is unchanged (both
  retrieved → still refused, its own #264 row).
- `packages/kajianq-domain/src/chat-neighbour-expansion.test.ts` — the
  expansion's own invariants, named before the code: an anchored window at an
  **arbitrary ordinal** (a verse at ordinal 255 of 286 receives its own
  neighbours, not the surah's opening); the radius and the cap both truncate
  and report `truncated`; a neighbour already fused or already added by the
  surah scope is not duplicated; `radius <= 0` and `cap <= 0` disable the
  expansion and issue no store read; a query with no retrieved verse issues no
  store read; anchor priority is the fused order, so the cap keeps the
  best-ranked evidence's neighbours.
- `packages/kajianq-domain/src/chat-retriever-assembler.test.ts` — the
  acceptance row at the boundary the gate actually reads: the **real failing
  retrieved set** (`QS. 3:2`, `QS. 3:18`, `QS. 3:189`) is retrieved, the
  assembled context contains `QS. 3:1` and `QS. 3:2`, and
  `validateCitations` on the **real failing label** (`QS. 3:1-2`) returns no
  ungrounded citation. The negative rows ride the same assembled context.
- `packages/infra/src/rag-store-postgres.unit.test.ts` — the new read at the
  adapter layer: the anchor array is bound and its order preserved, `radius`
  and `limit` are bound parameters, only neighbours are selected (never an
  anchor row), `limit <= 0` and an empty anchor list short-circuit without a
  query, and the returned order is the anchor-priority order.
- The falsification row: with `NEIGHBOUR_EXPANSION_RADIUS=0` (the documented
  disable) the assembled-context acceptance row goes red and the negative rows
  stay red — the mutation is named in the PR body.
- The generator measurement above is a query over `answer_traces`,
  `doc_children` and `chat_messages`, recorded in #274's comment with its
  before/after numbers.

## Implementation map

- `packages/infra/src/rag-store-corpus-seam.ts`,
  `rag-store-postgres-similarity.ts` — `listDocChildNeighboursByChildIds`.
- `packages/kajianq-domain/src/chat-neighbour-expansion.ts` — anchor
  selection, the radius/cap, dedup, the origin label, the trace detail;
  `chat-retriever-parts.ts` is the retriever's companion barrel (the 5-import
  agentic cap) and `chat-fusion.ts` the pure fusion arithmetic split out of
  `chat-retriever.ts` (the 300-line cap).
- `packages/kajianq-domain/src/chat-citation-grammar.ts`,
  `chat-citation-spelling.ts`, `chat-citation-normalize.ts` —
  `CitationGrammar.addressesOf`, `addressesNamedBy`, and the two same-subject
  splits (spelling, then normalization/scan) that keep the family inside the
  300-line agentic cap; `chat-citation-validator` re-exports both so its public
  surface is unchanged.
- `packages/kajianq-domain/src/chat-citation-validator.ts` — the ungrounded
  decision consults the candidate's declared address list.
- `packages/kajianq-domain/src/chat-retriever.ts` — the expansion runs after
  ADR-0045's scope expansion, over `fused ∪ scope`; the typed event is
  recorded through the run's collection point (ADR-0021).
- `packages/contracts/src/trace.ts` — the `neighbour_expansion` variant;
  `trace-events.ts` / `trace-primitives.ts` are the acyclic split of the event
  vocabulary from its field schemas that keeps `trace.ts` inside the 300-line
  cap, with the public surface re-exported unchanged.
- `apps/api/src/{env.ts,lib/chat-config.ts,lib/chat-wiring.ts,lib/server.ts}`,
  `provision/vps/api.env.example` — the two config knobs through the filtered
  env view.
- `SPECS.md` §3.3/§3.7/§5/§8 — the spec kept true.

## Revisit triggers

- **The cap truncates a range the model writes.** If the smoke (or traces)
  show a refused range whose addresses were in the corpus but outside the
  capped window, the ordering — not the radius — is the thing to revisit
  first: anchor priority is the fused rank today, and a citation-driven
  priority (cite the anchors whose neighbours the draft actually named) would
  need the gate's output, which the retriever does not see.
- **Hadith ranges.** The hadith grammar declares no address list, so
  `HR. Bukhari no. 5010—5011` stays refused even when both numbers were
  retrieved (the #264 A3 cost, unchanged). Extending `addressesOf` to it is a
  grammar-level declaration plus a test — deliberately not bundled here, so
  one grammar's semantics change at a time.
- **A third grammar with a list-valued address** (a Kitab volume range) must
  declare its own `addressesOf`; the comparison site is already generic.
- **Arabic-script or non-decimal ranges** (`QS. ٢:٢٥٥—٢٥٦`) are recognised and
  refused today (the digit posture on `CITATION_GRAMMARS`); a per-block fold
  would widen both the grammar and this list.
- **Cost per query.** If the neighbour expansion's 12 chunks measurably move
  per-query cost or latency, `NEIGHBOUR_EXPANSION_CAP` is the knob, and the
  measurement belongs in §5's cost table rather than in a code comment.
- **A reranker or a second retrieval channel** must decide whether it sees
  neighbour chunks; `origin: "verse_neighbours"` is the hook, exactly as
  ADR-0045 left `scope_expansion`.
