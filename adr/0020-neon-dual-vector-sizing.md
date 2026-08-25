# ADR-0020: Neon plan sizing for the dual 1536-dim vector schema

## Status

Accepted (2026-08-25, promoted from `docs/neon-sizing-issue-4.md` per issue
#63 item 6 — a storage/cost trade-off is a decision record, not runbook
content, per AGENTS.md §2 rule 7).

## Context

ADR-0013's amendment mandates building **both** embedding tracks from day 1:
each `doc_children` row carries two `VECTOR(1536)` columns
(`embedding_primary`, `embedding_fallback`; named `embedding_ar` /
`embedding_id` at the time of the original estimate), plus `text_raw`,
`text_ar`, `text_id`, and a `metadata` JSONB. The storage cost of that
optionality had to be made explicit **before** the #9 embedding benchmark
locks the retrieval posture, because re-embedding at kitab scale is expensive
(AGENTS.md §2 rule 10).

The numbers below are order-of-magnitude estimates recorded so the merge
decision is explicit — the point is to catch a plan-level miss early, not to
nail bytes.

### Corpus shape (v1)

| Source            | Rows (child chunks) | Notes                                       |
|-------------------|--------------------:|---------------------------------------------|
| Quran             |        ~6,236       | 1 ayah ≈ 1 child                            |
| Hadith            |       ~650,000      | 1 hadith ≈ 1 child                          |
| Kitab (~10 books) |        ~5,000       | ~10 books × ~500 pages, ~1 page ≈ 1 child   |
| **Total**         |      **~661,000**   | rounded up to ~700K for headroom            |

### Storage per row

- One 1536-dim float32 vector = 1536 × 4 B = **6,144 B ≈ 6 KiB**.
- Two vectors ≈ **12 KiB** per row of raw vector payload.
- pgvector HNSW index ≈ 1.2–1.5× the table's vector payload (graph overhead);
  assume ~**15–18 KiB/row** across both indexes.
- Text: Arabic ayah/hadith/kitab chunk ~0.5–2 KB; `text_raw` + `text_ar` +
  `text_id` ≈ ~3–5 KB/row average.
- `metadata` JSONB + row overhead ≈ ~1 KB/row.

**Per-row total (table + both indexes): ~25 KiB** as a comfortable estimate.

### Total

700,000 rows × ~25 KiB ≈ **17–18 GiB**.

Sanity check against a conservative split:

- Vector data alone: 700K × 12 KiB ≈ 8.4 GiB.
- Indexes alone: 700K × 15 KiB ≈ 10.5 GiB (HNSW is the dominant cost).
- Text + metadata: 700K × 5 KiB ≈ 3.5 GiB.

## Decision

1. **Accept the doubled vector storage as the known price of ADR-0013's
   dual-index optionality.** It does not block bring-up, but it is recorded
   here so the trade-off is visible: the "dual index from the start" amendment
   roughly **doubles** vector storage vs. the single-index starting point the
   original ticket assumed.
2. **Staging/dev branches carry a *sampled* corpus** during #6/#7 bring-up,
   not the full ~660K rows; that fits Neon's free tier (~0.5 GiB/branch)
   comfortably during development.
3. **Production sizes for the full corpus on the Launch tier or above.**
   Neon's Launch tier headline is 10 GiB; the realistic band once HNSW fully
   materializes is **10–50 GiB**, which at Neon's ~$1.75/GiB-month is roughly
   **$20–$90/month** for storage alone, before compute. Plan capacity against
   ~18 GiB when #6/#7 land, after #9 picks the retrieval posture.

## Consequences

- Two cost levers are already in the design if the estimate bites:
  1. **HNSW is the expensive part, not the vectors.** Vectors alone are
     ~8 GiB; HNSW roughly doubles that. Per-tuple cost is dominated by the
     index, so any reclaim targets indexes first.
  2. **The fallback track is optional at query time.** If #9's benchmark
     shows primary-only retrieval meets the recall bar, the
     `embedding_fallback` *index* can be dropped (data column kept) to
     reclaim ~5 GiB without re-embedding — the fallback data stays, only the
     ANN path is removed. That is a one-line migration, reversible, and is
     exactly the "switchable without re-ingestion" property ADR-0013's
     amendment bought.
- This fork's amended dependency guardrail (ADR-0009 amendment: paid LLM APIs
  accepted on the critical path) does not automatically cover *storage*;
  storage cost stays an explicit line item reviewed at production bring-up.
- Runbook-level sizing checks belong in `docs/` (or the infra README); this
  ADR holds only the decision and its numbers.

## Relationship to existing ADRs

- **ADR-0013:** supplies the dual-track schema whose storage cost is sized
  here; the #9 benchmark gate decides which tracks stay indexed.
- **ADR-0008:** persistence lives behind RagStore; plan sizing is invisible
  to consumers and changes never require re-ingestion.
- **AGENTS.md §2 rules 7/10:** this record exists so a trade-off (rule 7) and
  a gate-dependent posture choice (rule 10) have an auditable home.
