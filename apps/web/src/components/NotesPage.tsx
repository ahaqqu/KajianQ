import { useEffect, useState } from "react";
import type { Note } from "@app/shared-zod";
import { SCHEMA_VERSION } from "@app/sync-protocol";
import { t, type Locale } from "../lib/i18n";
import {
  listAlive,
  loadState,
  removeNote,
  upsertNote,
  type NotesState,
} from "../lib/notes-store";
import {
  clearSession,
  ensureSession,
  loadSession,
} from "../lib/session";
import { startSyncLoop, type SyncStatus } from "../lib/sync-loop";
import { Button, Card, Input, Textarea } from "./ui";

export function NotesPage({ locale }: { locale: Locale }) {
  const [state, setState] = useState<NotesState>({
    schemaVersion: SCHEMA_VERSION,
    notes: [],
  });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = () => {};
    void (async () => {
      try {
        await ensureSession();
      } catch {
        setStatus("offline");
      }
      const s = await loadState();
      setState(s);
      setReady(true);
      stop = startSyncLoop(setState, setStatus);
    })();
    return () => stop();
  }, []);

  const notes: Note[] = listAlive(state);

  const add = async () => {
    if (!title.trim()) return;
    const next = await upsertNote(state, {
      id: crypto.randomUUID(),
      title: title.trim(),
      body,
      updatedAt: Date.now(),
    });
    setState(next);
    setTitle("");
    setBody("");
  };

  const del = async (id: string) => {
    setState(await removeNote(state, id));
  };

  const wipe = async () => {
    const session = loadSession();
    if (!session) return;
    await fetch("/v1/auth/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.token}` },
    });
    clearSession();
    setState({ schemaVersion: SCHEMA_VERSION, notes: [] });
  };

  if (!ready) {
    return <p className="text-slate-400">{t(locale, "loading")}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <span data-testid="sync-status">
          {status === "offline"
            ? t(locale, "offline")
            : status === "syncing"
              ? t(locale, "syncing")
              : t(locale, "synced")}
        </span>
        <Button type="button" onClick={() => void wipe()} className="bg-slate-700 text-slate-100">
          {t(locale, "signOut")}
        </Button>
      </div>

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

      <ul className="space-y-2" data-testid="note-list">
        {notes.length === 0 && (
          <li className="text-slate-500" data-testid="note-empty">
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
                  className="bg-rose-500/90"
                  data-testid="note-delete"
                  onClick={() => void del(n.id)}
                >
                  {t(locale, "delete")}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
