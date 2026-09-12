# ADR-0039: Staging carries a minimal corpus; the full corpus is a production milestone

## Status

Accepted (2026-09-12). Scopes the staging corpus for the MVP. Amends the corpus
expectation in `SPECS.md` §2/§3.7; does not change ADR-0037 (who runs ingestion)
or ADR-0038 (how the result is protected).

## Context

- The staging corpus exists for one reason: the Golden Set smoke scores
  **retrieval recall from the persisted traces**, so the store must hold enough
  material for the questions it scores (SPECS §3.7).
- The full corpus — Quran (6,236 children) plus seven hadith collections
  (~35,573 children) — projects to **≈1.35 GB**. Measured on 2026-09-12: the
  store was already 235 MB after Quran alone, and `doc_children` spent 215 MB of
  that, of which **96 MB was the two HNSW indexes**.
- Neon's free plan caps storage at **0.5 GB per project**, and its documented
  behaviour on overage is that writes **fail**. So the full corpus cannot be
  loaded on staging at all without moving to a paid plan or a VPS.
- The MVP does not need corpus _completeness_. Of the five questions the PR-time
  smoke scores, two require **hadith** chunks and three require **Quran** chunks
  (by `expectedSourceTypes`); **none requires a specific collection**.
- Measured while deciding this: the Golden Set's fabricated-attribution trap
  (`gs-v0-020`, "seek knowledge unto China") targets a hadith that is **absent
  from all seven fawazahmed0 collections** — the Arabic "الصين" returns zero hits
  in every edition, and the one Indonesian "cina" match (Bukhari #6001) is a
  substring false positive in an unrelated hadith. No collection choice therefore
  makes that trap more or less meaningful.

## Decision

1. **Staging carries the smallest corpus that satisfies the gate**: Quran plus
   **one** hadith collection — Malik (Muwatta), ~1,829 records / ~56 MB, landing
   the store at ~291 MB (58% of the free cap).
2. **The full corpus is a production milestone**, loaded on the production store
   (the self-hosted Postgres hosting workstream), not on staging.
3. The smoke's evidence is a **behavioural gate on a partial corpus**, and the PR
   body says so plainly rather than implying corpus coverage.

## Rationale

- The gate scores _behaviour_ — refusal correctness, citation validity, recall by
  source type — not corpus coverage. Spending ~$1–4 and roughly two hours to
  satisfy a coverage invariant the gate never reads is exactly the waste ADR-0037
  exists to prevent.
- Scoping is cheap and reversible: adding a collection is one more
  `--offset N --limit 1` pass (ADR-0037 defines the pass), and the store keeps
  ~209 MB of headroom — enough for one more collection before the cap gets tight.
- It requires no plan change and no new infrastructure, so the MVP stays free and
  the hosting decision stays where it belongs: with production.

## Alternatives considered

- **Load all seven collections on staging.** Rejected: it needs a paid Neon plan
  or a VPS purely to hold data the gate does not read, and it front-loads a
  production concern into the MVP.
- **Drop the two HNSW indexes as the MVP retrieval path.** Real lever — it frees
  ~96 MB immediately and roughly halves the per-child cost, and the queries
  (`ORDER BY embedding <=> $1::vector LIMIT n`) remain correct without an index,
  just slower. Deferred rather than adopted: it trades a genuine latency property
  for capacity that scoping already provides, and the index rebuild belongs with
  the production migration.
- **Commit the corpus at lower embedding precision (`halfvec`, or MRL-truncated
  dimensions).** Potentially the largest lever at kitab scale — 2–4× the storage —
  but it changes the retrieval posture ADR-0036 decided and needs its own
  measurement gate before it can be adopted.
- **Split the corpus across several free Neon projects.** Rejected outright: one
  RagStore is one database; splitting it to dodge a storage cap would break the
  seam's whole premise.

## Consequences

- Staging retrieval is exercised against **one of seven** collections, so a bug
  specific to another collection's structure would not surface there.
- The two hadith-scored questions carry a residual **recall risk**: hadith chunks
  must enter each track's per-track top-10 against 6,236 Quran chunks. Measured
  mitigations: `HIERARCHY_BONUS` makes a sahih hadith (0.25) nearly competitive
  with Quran (0.3), `rrfFuse` returns every fused hit rather than truncating, and
  Malik is fiqh- and prayer-heavy — the subject matter of `gs-v0-015`. If recall
  nonetheless fails, the fallback is one more collection pass (~$0.15) while
  headroom remains.
- The Golden Set's dhaif trap deserves review at the `model:plus-human` curation
  gate: its target hadith is absent from the corpus entirely, so it currently
  tests "does not fabricate without evidence" rather than "refuses a
  present-but-weak hadith".
- Storage headroom on staging is a **live constraint**, not a settled one: the
  next corpus addition must be checked against the cap before it runs, because
  overage fails writes rather than warning.

## Implementation map

- `SPECS.md` §2 (staging corpus) and §8 (record of decisions).
- No code change: this is a scope decision, exercised through the existing
  `--offset`/`--limit` pass (ADR-0037) and protected by ADR-0038's snapshots.

## Revisit triggers

- The production store exists, or kitab ingestion begins → load the full corpus
  there and retire the minimal-corpus scope.
- A collection-specific retrieval bug appears → widen the staging corpus
  deliberately, checking headroom first.
- The HNSW or embedding-precision levers become necessary → each needs its own
  ADR and measurement gate (ADR-0036 territory).
