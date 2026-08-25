export type NoteRow = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted?: boolean | undefined;
};

/**
 * Canonical payload serialization, used only for deterministic tie-breaking
 * when two versions of the same note share an updatedAt stamp.
 */
function payloadKey(row: NoteRow): string {
  return JSON.stringify([row.title, row.body, row.deleted === true]);
}

/** Winner between two versions of the same note: newer updatedAt, then greater payload. */
function win(a: NoteRow, b: NoteRow): NoteRow {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return payloadKey(a) >= payloadKey(b) ? a : b;
}

/**
 * LWW-element-set: per-note last-write-wins by updatedAt with a deterministic
 * payload tie-break (so merge is commutative even on same-ms writes); a delete
 * always wins once seen. Output rows normalize `deleted` to true | undefined.
 */
export function mergeNotes(a: NoteRow[], b: NoteRow[]): NoteRow[] {
  const map = new Map<string, NoteRow>();
  for (const raw of [...a, ...b]) {
    // Normalize deleted on entry so output representation is input-independent
    // (idempotency: merging an already-merged set is a fixed point).
    const row: NoteRow = { ...raw, deleted: raw.deleted === true ? true : undefined };
    const prev = map.get(row.id);
    if (!prev) {
      map.set(row.id, row);
      continue;
    }
    const winner = win(prev, row);
    const deleted = prev.deleted === true || row.deleted === true;
    map.set(row.id, { ...winner, deleted: deleted ? true : undefined });
  }
  return [...map.values()];
}

export function aliveNotes(rows: NoteRow[]): NoteRow[] {
  return rows.filter((r) => !r.deleted);
}
