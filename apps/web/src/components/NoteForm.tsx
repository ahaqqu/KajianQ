import { useState } from "react";
import { t, type Locale } from "../lib/i18n";
import { Button, Card, Input, Textarea } from "./ui";

export function NoteForm({
  locale,
  onAdd,
}: {
  locale: Locale;
  onAdd: (title: string, body: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const add = async () => {
    if (!title.trim()) return;
    await onAdd(title.trim(), body);
    setTitle("");
    setBody("");
  };

  return (
    <Card>
      <h2 className="mb-2 text-sm font-medium">{t(locale, "addNote")}</h2>
      <div className="space-y-2">
        <Input
          data-testid="note-title"
          aria-label={t(locale, "title")}
          placeholder={t(locale, "title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          data-testid="note-body"
          aria-label={t(locale, "body")}
          placeholder={t(locale, "body")}
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button data-testid="note-save" type="button" onClick={() => void add()}>
          {t(locale, "save")}
        </Button>
      </div>
    </Card>
  );
}
