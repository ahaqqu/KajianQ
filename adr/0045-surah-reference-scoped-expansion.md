# ADR-0045: Surah-reference scoped expansion — a deterministic read of the surah a question names

## Status

Accepted (2026-09-27). Implements the owner-chosen direction for **#142**
(_short formulaic verses are unreachable for whole-surah questions_) and is the
fix for the retrieval half of **#241** (_`gs-v0-015` flaps on Staging because
the router's sub-query paraphrase drops the whole-surah question's Quran
chunks_). It changes retrieval semantics, which is why it is an ADR and not a
parameter change.

It does **not** relitigate ADR-0013 (Arabic canonical / Indonesian display,
dual-track retrieval), ADR-0036 (the embedding gate and its measured posture),
ADR-0008/ADR-0027 (the `RagStore` seam and its Effect signature), ADR-0021 (the
pipeline runner owns the trace), or ADR-0009 (cost discipline, config-driven
model choice). It adds no vendor call, no paid dependency, and no re-ingest.

**Amendment (2026-09-28, #274) — a second trigger, ADR-0049.** The expansion
this ADR defines is extended from "the question named a surah" to "a retrieved
chunk is a verse": `adr/0049` adds a bounded ordinal-neighbourhood read anchored
on the retrieved child ids (`RagStore.listDocChildNeighboursByChildIds`), its own
`origin: "verse_neighbours"` label, a `neighbour_expansion` trace event, and the
`NEIGHBOUR_EXPANSION_RADIUS` / `NEIGHBOUR_EXPANSION_CAP` knobs. ADR-0045's own
decision, detection, window, cap, and trace shape are unchanged, and its
`expansion.chunks` report keeps meaning the **scope** path only (ADR-0049
records that choice). ADR-0049 also completes the follow-up #264 recorded on
`DASH_JOINED_NUMBER_TAIL` — a range citation is now checked address by address
at the comparison site.

## Context

- **The measured gap.** Against the scoped staging corpus (Quran 6,236 + Malik
  1,829 = 8,305 children), `QS. 1:1` (the Basmalah) sits at **dense rank
  929 / 8,305** for the best router sub-query a live run produced, is absent
  from the primary and fallback tracks at every limit, and is **last of the
  seven Al-Fatihah verses by distance** for a plain `"Surah Al-Fatihah"` query.
  It is not a corrupt vector (its own text embeds to itself at distance 0.006):
  a short, formulaic verse is simply a poor semantic neighbour of a
  meta-question about its surah, and a pgvector HNSW scan returns at most
  `hnsw.ef_search` rows (default 40), so no limit tuning reaches rank 929.
- **The failure is silent and product-visible.** `docs/ARCHITECTURE.md` §2 and
  `SPECS.md` §2.2 make grounded, strictly-cited answers the #1 invariant. Today
  the product can answer a question about Surah Al-Fatihah while grounding
  itself in **no part of that surah at all** — the answer is under-cited or
  refuses, and nothing errors.
- **The flake is the same gap plus nondeterminism.** #241 traced two staging
  runs of the same commit: the router's LLM-generated English sub-query was
  paraphrased (`meaning and tafsir of Surah Al-Fatihah` vs `tafsir of Surah
Al-Fatihah meaning and virtues`), and Al-Fatihah verses retrieved went from
  `2, 5` to **none**. `retrievalRecall` is the share of `expectedSourceTypes`
  present, `passed` requires `recall === 1`, so the score follows arithmetically
  (`0.5` → fail, then the answer refuses). Keying the fix on sub-query wording
  would reproduce the nondeterminism.
- **The fixture is already re-curated once and must not be again.**
  `gs-v0-015`'s `requiredCitations` moved from `QS. 1:1` to `QS. 1:2` in
  2026-09-12 (owner decision, recorded in the fixture). Its `$comment` is
  explicit that hiding the gap in the fixture is the wrong move; the point is
  to make the short verse reachable.
- **The candidate directions were #142's.** (1) surah/verse-reference scoped
  expansion; (2) reference-augmented embeddings (prepend the citation label
  and/or translation to the embedded text, then re-embed the corpus — a paid
  re-ingest in tension with ADR-0013/ADR-0036); (3) a lexical/reference track
  fused as a third RRF list. #241 added (4) stabilize the gate only (pin router
  sampling / grow the smoke), which does not fix recall at all.

## Decision

1. **Retrieve the named surah's children deterministically, alongside the fused
   hits — never instead of them.** When the verbatim question names a surah (or
   a verse inside one), the retriever reads that surah's parent document and
   adds a bounded window of its children to the retrieved set. The read is a
   direct store lookup: no embedding, no LLM, no dependence on how the router
   phrased anything.

2. **Detection is Islamic-domain logic and lives in `packages/kajianq-domain`.**
   `detectSurahReference` matches (a) an explicit address — `QS. 2:255`,
   `Q.S. 2`, `QS 2`, `surah 2`, `surat ke-2` — and (b) a surah name immediately
   preceded by `surah`/`surat`, in its canonical, article-stripped,
   space-insensitive compact (`yasin`, `annas`) or elongation-collapsed
   (`yaa siin`) form, plus the table's explicit aliases (`Thaha`) — every form
   gated on the marker, never matched bare. An address's verse number is
   validated against the surah's own ayah count (the table carries the 114
   Tanzil counts, Σ = 6,236, pinned in test against the committed surah-list
   fixture and the corpus total), so the trace's `value` never names a verse
   the surah does not have: `QS. 1:999` records surah 1, and a verse the
   grammar cannot validate (`surat al-baqarah ayat 255` carries no number)
   records the surah alone rather than inventing one. The name table is a
   hand-maintained 114-entry Latin-transliteration list in the domain pack
   (module `surah-names.ts`); it is not corpus data and deliberately does not
   carry Kemenag's Indonesian translated names (human prerequisite #2 still
   gates their redistribution).

3. **A bare surah name is not a reference.** Almost every surah name is also an
   ordinary Arabic word or a divine name, and the Golden Set proves it:
   `gs-v0-012` asks about _asmaul husna_ **Ar-Rahman**, not Surah Ar-Rahman. The
   detector therefore requires the explicit `surah`/`surat` marker (or an
   explicit address). Bare-name recognition is a recorded trade-off with a
   revisit trigger, not an oversight.

4. **Detection runs on the verbatim question, not on a router sub-query.** The
   engine's `RoutedQuery` gains an opaque `sourceText` (the caller question the
   routing decomposed), which the domain router fills from `Query.text`. This is
   the property that closes #241: the same question expands identically
   whatever the router's paraphrase, and a paraphrase that drops the surah name
   entirely still expands.

5. **The expansion is bounded by an explicit, configurable cap, and the
   truncation rule is stated.** `DEFAULT_SCOPE_EXPANSION_CAP = 12`;
   `apps/api` reads `SCOPE_EXPANSION_CAP` (non-negative integer; `0` disables;
   a malformed value is a typed config failure, never a silent default). The
   window is the parent's stable `ordinal` order — the corpus's
   `UNIQUE (parent_id, ordinal)` key — so a short surah (Al-Fatihah, 7 verses)
   is retrieved whole and a long one (Al-Baqarah, 286) yields its deterministic
   **opening** `cap` children. The read probes `cap + 1` rows; a full probe is
   the exact truncation signal, so the trace reports `truncated` without a
   second count query.

6. **The expansion is a first-class trace path, not a silent fallback.** A new
   typed `scope_expansion` event records the opaque scope `key`/`value` the
   domain pack chose (e.g. `surah` / `1`), `returned`, `cap`, and `truncated`;
   and each chunk the expansion added carries `origin: "scope_expansion"` on
   its trace chunk ref, so a scorer can tell an expansion chunk from a fused
   one. A recognised-but-empty scope is still recorded (`returned: 0`). The
   label is projected end-to-end: the user-facing Trace frame's technical
   layer carries it (`ChatTraceChunk.origin`, #243 A1), and the eval harness
   records the expansion's per-question contribution on the outcome
   (`expansion.chunks` / `expansion.fusedOnlyRetrievalRecall`, #243 C1) — the
   path is visible to the panel reader and to the report reader, not only to
   someone querying `answer_traces` directly.

7. **The new engine surface is generic — zero domain vocabulary crosses into
   `rag-core`.** The additions are: `RoutedQuery.sourceText` (opaque),
   `Chunk.origin` (an opaque label), the `scope_expansion` trace variant (keys
   and values are opaque strings), and one `RagStore` read,
   `listDocChildrenByParentSourceKey(parentSourceKey, { limit })` — the parent
   is addressed by its opaque provenance key and the store never learns what a
   document is. The surah number, the citation grammar, and the name table stay
   in the domain pack; the engine never names a surah.

## Rationale

- **Deterministic beats semantic for a reference the user already stated.**
  When a question says "Surah Al-Fatihah", the surah's identity is given, not
  inferred. Reading its children is a lookup whose result cannot vary between
  runs — the property reference-augmented embeddings would not have (they
  change distances for every chunk and still leave a borderline verse
  borderline) and the property a third lexical RRF list would only partly
  have (it helps explicit `QS. n:m` and leaves whole-surah questions, which
  name no address, exactly where they are).
- **The fix is worth more than the flaky gate.** #241 is a gate symptom; the
  defect is that a whole-surah question can be answered with no part of that
  surah. Fixing the class also removes the coin flip, so the gate stops
  reporting a real regression and this flake identically.
- **Bounded by construction, because context is the cost.** Al-Baqarah is 286
  verses; an uncapped expansion would blow the assembly budget and change cost
  per query. The cap is a number an operator sets, and the trace shows the
  budget the expansion actually spent, so the cost delta is observable rather
  than assumed.
- **Traceability is the product boundary here, not a nicety.** A retrieval path
  that adds chunks without leaving a record is the silent machinery the trace
  exists to prevent — especially for a fix whose whole purpose is that "what
  the answer consulted" changes.

## Alternatives considered

- **Reference-augmented embeddings (#142 direction 2).** Prepend the citation
  label and/or the Indonesian translation to the embedded text and re-embed the
  corpus. Rejected as the direction now: it changes the embedding input for
  every chunk, so it is a paid re-ingest with pre/post snapshots (ADR-0038)
  plus a re-validation of the embedding gate (ADR-0036), and it treats a stated
  identity as a similarity problem to be nudged. Its real advantage — general
  short-verse recall, including questions that name no reference — is a
  separate, still-open improvement; this ADR does not claim it is unnecessary.
- **A lexical/reference track fused as a third RRF list (#142 direction 3).**
  Cheap and deterministic, but it only helps questions that name an explicit
  address (`QS. 1:1`), and `gs-v0-015` names a _surah_, not an address. It also
  competes with the fused ranks instead of guaranteeing the surah's presence —
  the guarantee is the point. Rejected as the direction; the explicit-address
  path here subsumes its useful half.
- **Stabilize the gate only (#241 direction 4).** Pin the router's sampling
  and/or grow the smoke sample. Rejected: it does not fix recall, and at best
  makes the question deterministically failing. It would also leave #142 open
  while removing the signal that shows it.
- **Bare-name matching (no `surah`/`surat` marker).** Rejected on measured
  evidence: the Golden Set's own `gs-v0-012` would have expanded Surah
  Ar-Rahman into a question about the divine name Ar-Rahman. Recall for
  `Al-Fatihah`-without-the-marker phrasing is given up deliberately; see the
  revisit trigger.
- **An LLM call to detect the reference.** Rejected on cost and determinism:
  it adds a paid call where a pure string match is exact, and it reintroduces
  the run-to-run variation this ADR exists to remove.
- **Expanding every surah a comparison question names, or centering the window
  on a named verse.** Deferred, not rejected: both multiply or complicate the
  budget and need reads the corpus seam does not have (an ordinal-by-citation
  lookup). The bounded opening window satisfies the ticket's case; the
  limitations are stated in the revisit triggers rather than papered over.
- **Re-curating `gs-v0-015` again.** Rejected outright — the fixture's
  `$comment` says so, and it would hide the gap the ticket exists to expose.
  `requiredCitations` is unchanged by this ADR.

## Consequences

- **A whole-surah question now grounds itself in that surah — and the gate's
  reading of that changed, so the report must say so.** `QS. 1:1` becomes
  reachable for a question about Surah Al-Fatihah, independent of the router's
  wording, so `gs-v0-015`'s `retrievalRecall` no longer depends on a coin
  flip. The belief that #241 is resolved rests on the hermetic tests and on the
  mechanism, not on a single live run — closing #241 is the manager's call
  after the change is observed on `main`. Two properties have to be stated
  together, because either one alone misreads the number:
  - **For the four Golden Set questions that name a reference**
    (`gs-v0-005`/`009`/`014`/`015`), the scored leg of `retrievalRecall` is
    satisfied **by construction** whenever the scoped read works: the scorer
    (`packages/eval/src/scorers.ts`) reads the retrieval event's chunk refs and
    never inspects their `origin`, so on those four questions the metric
    measures "the question saw its reference", not "the fused tracks found
    it". The other sixteen questions still measure the fused path, and
    `citationValidity` still binds verse-specific requirements (`gs-v0-009`'s
    `QS. 89:28` sits outside surah 89's opening window, so a broken fused
    track still fails that question on citations).
  - **The looseness is reported, not silent.** Each scored outcome persists the
    expansion's contribution (`expansion.chunks`, the count of expansion-origin
    refs, and `expansion.fusedOnlyRetrievalRecall`, the recall the fused refs
    alone would have scored — same resolver, same expected sources), the CLI
    summary prints a `scoped:` line per such question, and the user-facing
    Trace frame carries the ref's `origin`. A fused-only figure below the
    reported one is the report's own statement that the expansion carried the
    question, so a fused-Quran regression on those four is visible in
    `eval_runs.report` instead of only in the raw trace. The metric itself is
    unchanged and no LLM judge is involved.
- **A failure on the expansion read fails the retrieval — deliberately
  fail-closed, and recorded here because the code alone does not say so.** The
  read is wrapped by the retriever's `toStageError("retriever", …)` exactly
  like the fused `similaritySearch` calls, so a transport/timeout fault on this
  additive read rejects the whole answer rather than degrading to the fused
  hits. Chosen over mirroring `filter_relaxed`'s degrade-with-trace because the
  two situations differ in kind: `filter_relaxed` handles a _successful_ read
  that matched nothing (a wrong router hint, retried once wider), while this is
  an infrastructure error — and degrading on it would let a store blip answer a
  whole-surah question with no part of that surah, the exact silent failure
  this ADR exists to close, behind a 200 response. Failing loudly is also
  uniform with the fused path, so one posture governs both reads.
- **Cost per scoped query rises by at most `cap` chunks of prompt.** No vendor
  call is added. The expansion is a bounded extra store read plus at most
  `cap` children in the assembled context; for unscoped questions the cost is
  unchanged and no store read happens at all.
- **Retrieval semantics changed, so retrieval tuning knobs now interact with a
  new path.** A future sparse/lexical channel, reranker, or Deep Think mode
  (ADR-0011) must decide whether it also sees scope-expansion chunks; today the
  expansion happens after fusion and before assembly, and the chunks carry
  `origin` so a later stage can distinguish them.
- **The trace contract grew by one optional chunk field and one event kind.**
  Both are additive (`ChunkRef.origin`, `scope_expansion`), so persisted traces
  stay readable per ADR-0007's forward-compatibility rule; the contract test
  parses a trace containing each **and** a pre-change ref without it. The
  user-facing frame grew the matching optional `ChatTraceChunk.origin`
  (projected by `apps/api/src/lib/chat-trace.ts`), and the eval outcome the
  optional `expansion` block — both additive, both pinned by a pre-change
  fixture so an older persisted record still parses and renders.
- **A store read was added to the seam.** `RagStore` gains
  `listDocChildrenByParentSourceKey`; the Postgres adapter implements it as an
  indexed point lookup on `doc_parents.source_key` joined to `doc_children`
  ordered by `ordinal`, and the in-memory test store mirrors it. Any future
  adapter must implement it, which is the seam's normal cost.

## Evidence

- `packages/kajianq-domain/src/chat-scope-expansion.test.ts` — the invariant:
  a whole-surah question expands and retrieves all seven Al-Fatihah children
  (with `QS. 1:1`); a non-surah question expands nothing and issues no store
  read; a 286-verse surah is capped at `cap` with `truncated: true`; an
  already-fused child is not duplicated; `cap: 0` disables. The #241 block runs
  the **exact failing sub-query** (`tafsir of Surah Al-Fatihah meaning and
virtues`) and the **passing one** (`meaning and tafsir of Surah Al-Fatihah`)
  and asserts identical expansion labels including `QS. 1:1`, plus a paraphrase
  that drops the surah name entirely.
- `packages/kajianq-domain/src/surah-reference.test.ts` — detection and its
  traps, including running the detector over every Golden Set question and
  pinning the exact set that expands (four of twenty), so a future name-table
  edit that starts matching an unrelated question fails the suite.
- `packages/contracts/src/trace.test.ts` — the `scope_expansion` event and
  `ChunkRef.origin` parse under the shared contract, and a pre-change ref
  without the label still parses;
  `packages/kajianq-domain/src/chat-scope-expansion.test.ts`'s last block runs
  the real `runChatPipeline` runner and reads the parsed trace.
- `packages/contracts/src/chat.test.ts` — the user-facing frame carries the
  optional `origin` label and a pre-change frame (no chunk labelled) still
  parses; `apps/api/src/lib/chat-trace.test.ts` pins the projection and that a
  pre-change trace derives a contract-valid frame with no `origin` key.
- `packages/contracts/src/eval.test.ts`, `packages/eval/src/scorers.test.ts`,
  `packages/eval/src/harness.test.ts` — the outcome's `expansion` block:
  computed from the trace refs and the caller-supplied origin label, absent
  when the scoped path did not run or no label was supplied, and persisted on
  the per-question row; a pre-change outcome without it still parses.
- `packages/kajianq-domain/src/surah-reference.test.ts` — the per-surah ayah
  counts are pinned against the committed Tanzil surah-list fixture and the
  corpus total (Σ = 6,236), so an impossible verse cannot be recorded; the
  one-word marker-gated spellings (`yasin`, `thaha`, `yaa siin`) resolve.
- `packages/infra/src/rag-store-postgres.unit.test.ts` — the new read binds the
  source key and limit, orders by `ordinal`, and short-circuits `limit <= 0`;
  the `insertAnswerTrace` fixture carries the `scope_expansion` event and an
  `origin`-bearing ref, so the new variant's insert→read round trip is
  exercised, not inferred from the shared contract.
- The live ranked-recall measurement #142's acceptance criteria ask for
  (`QS. 1:1`, `QS. 112:1`, `QS. 103:1` before/after) requires staging secrets
  and the live corpus, so it is **not** claimed here; the hermetic tests prove
  the reachability deterministically, and the first staging smoke after merge
  is the live observation.

## Implementation map

- `packages/kajianq-domain/src/surah-names.ts`, `surah-reference.ts` — the name
  table and the (pure, hermetic) detector.
- `packages/kajianq-domain/src/chat-scope-expansion.ts` — the bounded read, the
  cap, the provenance label, and the trace detail; `chat-retriever.ts` wires it
  after RRF fusion; `chat-router.ts` carries `sourceText`.
- `packages/rag-core/src/pipeline.ts`, `run.ts` — `RoutedQuery.sourceText`,
  `Chunk.origin`, and the chunk-ref projection.
- `packages/contracts/src/trace.ts` — the `scope_expansion` variant and
  `ChunkRef.origin`.
- `packages/infra/src/rag-store-corpus-seam.ts`,
  `rag-store-postgres-similarity.ts`, `rag-store-postgres-corpus.ts` — the
  parent-scoped read.
- `apps/api/src/lib/chat-wiring.ts`, `env.ts`, `lib/server.ts` — the
  `SCOPE_EXPANSION_CAP` config knob through the filtered env view;
  `apps/api/src/lib/chat-trace.ts` — the frame's `origin` projection (A1).
- `packages/contracts/src/eval.ts`, `packages/eval/src/harness.ts`,
  `packages/eval/scripts/{staging-harness,eval-cli,eval-run,eval-smoke}.mjs` —
  the per-question expansion provenance and its report/CLI surfacing (C1); the
  origin label is injected at the composition root, so the engine package
  compares an opaque string and never names a caller's label.
- `SPECS.md` §3.3/§3.7/§8, `CONTEXT.md` — the spec kept true and the new term.

## Revisit triggers

- **Bare-name recall becomes worth the risk.** If questions phrased without
  `surah`/`surat` (`What does Al-Fatihah mean?`) measurably matter, the marker
  requirement is revisited — the fix is a disambiguation rule, not a wider
  match, and `gs-v0-012` is the trap it must keep passing.
- **Latin-spelling variants beyond the table's rules.** Under the explicit
  `surah`/`surat` marker the detector matches the canonical name, its
  article-stripped form, the space-insensitive compact form (`yasin`, `annas`),
  the elongation-collapsed form (`yaa siin`) and the table's explicit aliases
  (`Thaha`) — never a bare name, so the `gs-v0-012` trap is untouched. A variant
  no rule reaches (an inserted or dropped consonant: `Yaseen`, `Fatehah`; or a
  Kemenag Indonesian translated name, still gated by human prerequisite #2) is
  not recognised; adding one is a table alias plus a test, not a wider match.
- **The elongation collapse's own false-positive surface.** Collapsing repeated
  vowels also pulls an ordinary doubled-vowel word after the marker onto a bare
  name form — `surat fiil madhi` resolves to Al-Fil (105) through
  `fiil` → `fil`, which no pre-collapse rule reached — and that class is pinned
  as accepted-as-is in `surah-reference.test.ts` rather than narrowed away,
  because narrowing the collapse would reopen the `yaa siin`/`annas` spellings
  A3 fixed (realism is weak and the cost is bounded to a 5-verse surah).
- **A multi-surah comparison question** ("the difference between Al-Fatihah and
  Al-Ikhlas") needs both scopes expanded under one total budget; today only the
  first reference expands.
- **A verse-centered window** for a long surah (`QS. 2:255`) needs an
  ordinal-by-citation read the corpus seam does not have; today a verse
  reference expands its surah's opening window.
- **A second retrieval channel or reranker** (sparse/BM25, Deep Think) must
  decide how it treats scope-expansion chunks; `origin` is the hook.
- **Arabic-script surah names** (`سورة الفاتحة`) are not recognised; adding
  them is a domain-table change plus normalization, not an engine change.
- **A future embedding re-ingest** (ADR-0036 revisit) may improve short-verse
  recall generally; that does not invalidate this guarantee, but the two should
  be measured together rather than assumed to compose.
