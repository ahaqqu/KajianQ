import { filterMatchOf, isRelationFilter, type MetadataFilterValue } from "@app/infra";

/** One transmission row as the double stores it: the columns a relation filter binds. */
export type FilterChainRow = {
  readonly grade: string | null;
  readonly narratorIds: readonly string[];
};

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
 *
 * A relation clause is answered against the rows attached to the child: `grade`
 * matches when any row's classification is one of the values, `narratorIds` when
 * any row's ordered sequence contains one of the ids (the adapter's `&&` array
 * overlap). No rows means no match, which is what the SQL's `EXISTS` yields.
 */
export function matchesMetadataFilters(
  metadata: Record<string, unknown>,
  filters: Record<string, MetadataFilterValue> | undefined,
  chains: readonly FilterChainRow[] = [],
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
    if (isRelationFilter(wanted)) {
      const hit =
        wanted.on === "grade"
          ? chains.some((row) => row.grade !== null && wanted.values.includes(row.grade))
          : chains.some((row) => row.narratorIds.some((id) => wanted.values.includes(id)));
      if (!hit) return false;
      continue;
    }
    const match = filterMatchOf(wanted);
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
