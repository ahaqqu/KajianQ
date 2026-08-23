# Neon plan sizing for dual 1536-dim vectors (issue #4, ADR-0013 amendment)

Status: pre-merge estimate, recorded so the merge decision is explicit. Numbers
are order-of-magnitude; the point is to catch a plan-level miss *before* the
retrieval posture is locked by the #9 benchmark, not to nail bytes.

## Corpus shape (v1)

| Source            | Rows (child chunks) | Notes                                       |
|-------------------|--------------------:|---------------------------------------------|
| Quran             |        ~6,236       | 1 ayah ≈ 1 child                            |
| Hadith            |       ~650,000      | 1 hadith ≈ 1 child                          |
| Kitab (~10 books) |        ~5,000       | ~10 books × ~500 pages, ~1 page ≈ 1 child   |
| **Total**         |      **~661,000**   | rounded up to ~700K for headroom            |

The `doc_children` table carries **two** `VECTOR(1536)` columns
(`embedding_ar`, `embedding_id`) per row, per ADR-0013's build-both-from-day-1
decision, plus `text_raw`, `text_ar`, `text_id`, and a `metadata` JSONB.

## Storage per row

- One 1536-dim float32 vector = 1536 × 4 B = **6,144 B ≈ 6 KiB**.
- Two vectors ≈ **12 KiB** per row of raw vector payload.
- pgvector HNSW index ≈ 1.2–1.5× the table's vector payload (graph overhead);
  assume ~**15–18 KiB/row** across both indexes.
- Text: Arabic ayah/hadith/kitab chunk ~0.5–2 KB; `text_raw` + `text_ar` +
  `text_id` ≈ ~3–5 KB/row average.
- `metadata` JSONB + row overhead ≈ ~1 KB/row.

**Per-row total (table + both indexes): ~25 KiB** as a comfortable estimate.

## Total

700,000 rows × ~25 KiB ≈ **17–18 GiB**.

Sanity check against a conservative split:
- Vector data alone: 700K × 12 KiB ≈ 8.4 GiB.
- Indexes alone: 700K × 15 KiB ≈ 10.5 GiB (HNSW is the dominant cost).
- Text + metadata: 700K × 5 KiB ≈ 3.5 GiB.

## Does the Neon plan hold it?

Neon's current (2026) free tier is ~0.5 GiB per branch; the first paid tier
(Launch) is 10 GiB. **Dual 1536-dim vectors at full-corpus scale do not fit in
either tier's headline number unless only the staging/dev branch carries the
full corpus.** Practical reading:

- **Staging/dev branches** carry a *sampled* corpus during #6/#7 bring-up, not
  the full 660K rows. That fits comfortably in free tier during development.
- **Production** with the full corpus needs the **Launch tier (10 GiB)
  at minimum, and realistically one step up** once HNSW fully materializes —
  plan on the **10–50 GiB** band, which at Neon's ~$1.75/GiB-month is roughly
  **$20–$90/month** for storage alone, before compute.

This is not surprising enough to block #4 (it is the known price of the
ADR-0013 dual-index optionality), but it **is** worth surfacing: the "dual
index from the start" amendment roughly **doubles** vector storage vs. the
single-index starting point the ticket originally assumed.

## Two cost levers already in the design (not implemented here)

1. **HNSW is the expensive part, not the vectors.** Vectors alone are ~8 GiB;
   HNSW roughly doubles that. Neon's per-tuple cost is dominated by the index.
2. **The `id` track is optional at query time.** If #9's benchmark shows
   AR-only retrieval meets the recall bar, the `embedding_id` *index* could be
   dropped (data column kept) to reclaim ~5 GiB without re-embedding — the
   fallback data stays, only the ANN path is removed. That is a one-line
   migration, reversible, and is exactly the "switchable without re-ingestion"
   property ADR-0013's amendment bought.

## Recommendation

Proceed on the Launch tier for staging bring-up with a **sampled** corpus;
size the production branch honestly (~18 GiB) when #6/#7 land, after #9 picks
the retrieval posture. This file is the record; no ADR needed — the cost is
within the fork's amended guardrail ("paid APIs accepted in the critical path"
does not cover *storage*, so this gets an explicit PR note, per AGENTS.md §4).
