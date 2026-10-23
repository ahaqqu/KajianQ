import type { MetadataFilterMatch, MetadataFilterValue } from "@app/infra";

/**
 * The adapter binds each filter dimension as `metadata->>$k = ANY($v::text[])`,
 * so a row matches when the key's JSON *text* is one of the requested values: a
 * string matches itself, a number or boolean matches its text form, and a key
 * that is absent, JSON `null`, or an array/object matches nothing (its `->>` text
 * is `null` or the serialized JSON, which no single value equals). A clause's
 * `whenAbsent` alternative is the same test on a second key, reached only when
 * the dimension's own key yields no text — the derived case the adapter's
 * `(key = ANY(…) OR (key IS NULL AND other = ANY(…)))` expresses. An empty or
 * absent filter record constrains nothing.
 */
export function matchesMetadataFilters(
  metadata: Record<string, unknown>,
  filters: Record<string, MetadataFilterValue> | undefined,
): boolean {
  const textOf = (key: string): string | null => {
    const raw = metadata[key];
    if (raw === undefined || raw === null) return null;
    return typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : JSON.stringify(raw);
  };
  for (const [key, wanted] of Object.entries(filters ?? {})) {
    // `Array.isArray` does not narrow a `readonly string[]` in the false branch,
    // so the non-array branch restates the seam's own type.
    const match: MetadataFilterMatch =
      typeof wanted === "string"
        ? { values: [wanted] }
        : Array.isArray(wanted)
          ? { values: [...(wanted as string[])] }
          : (wanted as MetadataFilterMatch);
    const text = textOf(key);
    if (text !== null) {
      if (match.values.includes(text)) continue;
      return false;
    }
    const alternative = match.whenAbsent;
    const alternativeText = alternative === undefined ? null : textOf(alternative.key);
    if (alternativeText !== null && alternative !== undefined) {
      if (alternative.values.includes(alternativeText)) continue;
    }
    return false;
  }
  return true;
}
