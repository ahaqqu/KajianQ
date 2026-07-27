export type NoteRow = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted?: boolean | undefined;
};

/** LWW by updatedAt; delete always wins once seen. */
export function mergeNotes(a: NoteRow[], b: NoteRow[]): NoteRow[] {
  const map = new Map<string, NoteRow>();
  for (const row of [...a, ...b]) {
    const prev = map.get(row.id);
    if (!prev) {
      map.set(row.id, row);
      continue;
    }
    if (row.deleted || prev.deleted) {
      const newer = row.updatedAt >= prev.updatedAt ? row : prev;
      map.set(row.id, { ...newer, deleted: true });
      continue;
    }
    map.set(row.id, row.updatedAt >= prev.updatedAt ? row : prev);
  }
  return [...map.values()];
}

export function aliveNotes(rows: NoteRow[]): NoteRow[] {
  return rows.filter((r) => !r.deleted);
}
