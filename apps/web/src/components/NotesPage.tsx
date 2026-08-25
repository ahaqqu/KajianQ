import { t, type Locale } from "../lib/i18n";
import { NoteForm } from "./NoteForm";
import { NotesHeader } from "./NotesHeader";
import { NoteList } from "./NoteList";
import { useNotes } from "./use-notes";

export function NotesPage({ locale }: { locale: Locale }) {
  const { ready, notes, status, add, del, wipe } = useNotes();

  if (!ready) {
    return <p className="text-slate-400">{t(locale, "loading")}</p>;
  }

  return (
    <div className="space-y-4">
      <NotesHeader status={status} locale={locale} onSignOut={wipe} />
      <NoteForm locale={locale} onAdd={add} />
      <NoteList notes={notes} locale={locale} onDelete={del} />
    </div>
  );
}
