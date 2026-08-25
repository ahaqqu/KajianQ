import type { Note } from "@app/contracts";
import { t, type Locale } from "../lib/i18n";
import { Button, Card } from "./ui";

export function NoteList({
  notes,
  locale,
  onDelete,
}: {
  notes: Note[];
  locale: Locale;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <ul className="space-y-2" data-testid="note-list">
      {notes.length === 0 && (
        <li className="text-slate-400" data-testid="note-empty">
          {t(locale, "empty")}
        </li>
      )}
      {notes.map((n) => (
        <li key={n.id} data-testid="note-item">
          <Card>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-medium">{n.title}</h3>
                <p className="text-sm text-slate-400 whitespace-pre-wrap">
                  {n.body}
                </p>
              </div>
              <Button
                type="button"
                variant="danger"
                data-testid="note-delete"
                onClick={() => void onDelete(n.id)}
              >
                {t(locale, "delete")}
              </Button>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
