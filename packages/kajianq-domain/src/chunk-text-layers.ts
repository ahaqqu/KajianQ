/**
 * The single owner of the chunk-metadata text-layer rule (ADR-0006; B1 of
 * #243's review).
 *
 * The store's text columns are the only place the Arabic original and the
 * Indonesian translation exist, and the assembler's Arabic +
 * labeled-translation rule reads them off `metadata.textAr`/`metadata.textId`.
 * Both retrieval paths — the fused RRF hits (`chat-retriever.ts`) and the
 * surah-scope expansion (`chat-scope-expansion.ts`) — therefore build their
 * metadata through this one function. Two copies would be two owners: a future
 * third text layer or a different empty-string guard would have to be applied
 * twice, and one path would silently drift.
 *
 * The empty-string guard is deliberate. `textId === ""` is a store row with no
 * translation; attaching it would let the assembler render an empty labeled
 * translation instead of omitting the layer, and `textAr` is always present on
 * a Quran/hadith child row (its absence is a corpus bug, not a layer choice).
 */
export function withTextLayers(
  metadata: Record<string, unknown>,
  textAr: string,
  textId: string | null,
): Record<string, unknown> {
  return {
    ...metadata,
    textAr,
    ...(textId !== null && textId !== "" ? { textId } : {}),
  };
}
