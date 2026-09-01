import type { DocChildInsert } from "./rag-store";
import { CORPUS_EMBEDDING_DIM, toVectorLiteralChecked } from "./rag-store-shared";

/**
 * SQL construction for the Neon RagStore's batched child upsert
 * (`insertDocChildren`), kept beside `rag-store-neon-query.ts` so the
 * adapter file stays focused on seam wiring. All executable SQL in the
 * repository lives in these two files (and the migrations).
 */

/**
 * Build one multi-row upsert for `doc_children`. The driver escapes every
 * value; the JSON columns get their cast in the SQL text (not inside a bound
 * value, which Postgres would reject). Placeholder numbering is computed
 * while the rows are walked, so slot order and the params array always
 * agree. Returns the query text, the params in slot order, and each row's
 * caller-supplied (or freshly generated) id for the empty-RETURNING
 * fallback.
 */
export function buildBatchChildUpsert(batch: readonly DocChildInsert[]): {
  text: string;
  values: unknown[];
  rowIds: readonly string[];
} {
  const values: unknown[] = [];
  const rowIds: string[] = [];
  const rows = batch
    .map((input) => {
      const id = input.id ?? crypto.randomUUID();
      rowIds.push(id);
      const embeddingPrimary = toVectorLiteralChecked(
        input.embeddingPrimary,
        CORPUS_EMBEDDING_DIM,
      );
      const embeddingFallback = toVectorLiteralChecked(
        input.embeddingFallback,
        CORPUS_EMBEDDING_DIM,
      );
      const slot = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      return `(
        ${slot(id)},
        ${slot(input.parentId)},
        ${slot(input.textRaw)},
        ${slot(input.textAr)},
        ${slot(input.textId)},
        ${slot(JSON.stringify(input.citation ?? {}))}::jsonb,
        ${slot(embeddingPrimary)},
        ${slot(embeddingFallback)},
        ${slot(input.ordinal)},
        ${slot(JSON.stringify(input.metadata ?? {}))}::jsonb
      )`;
    })
    .join(",\n");
  const text = `
    INSERT INTO doc_children (
      id, parent_id, text_raw, text_ar, text_id, citation,
      embedding_primary, embedding_fallback, ordinal, metadata
    )
    VALUES ${rows}
    ON CONFLICT (parent_id, ordinal) DO UPDATE
      SET text_ar = EXCLUDED.text_ar,
          text_id = EXCLUDED.text_id,
          citation = EXCLUDED.citation,
          embedding_primary = EXCLUDED.embedding_primary,
          embedding_fallback = EXCLUDED.embedding_fallback,
          metadata = EXCLUDED.metadata
    RETURNING id
  `;
  return { text, values, rowIds };
}