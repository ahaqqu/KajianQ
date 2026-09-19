import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useChat } from "../lib/use-chat";
import { ChatView } from "./chat/ChatView";

/**
 * The KajianQ chat route (#11): replaces the template home. The hook owns
 * rehydration + streaming state; the view is presentational. The selected
 * locale drives the `language` field sent to /v1/chat (Indonesian default).
 *
 * Pre-fill (#175): the route also accepts `?q=<question>` — the collection
 * page's "Ask about this source" affordance links here with a question about
 * the entry. The pinned semantics:
 *
 *  - The param is a DRAFT SEED ONLY, never auto-sent. It is handed to the view
 *    as `prefill`; the view drops it into the composer and nothing else. No
 *    request, no session, no server contract is touched (ADR-0040) — the
 *    composer draft stays local-only.
 *  - It is read ONCE and CONSUMED: the param is stripped from the URL with a
 *    replace navigation, so a refresh of the chat does not re-seed an old
 *    question. Route search validation already dropped any unusable `q`
 *    (`lib/chat-prefill`), so reaching here means the seed is usable.
 *  - An absent param leaves the composer untouched.
 */
export function ChatPage({ locale }: { locale: "id" | "en" }) {
  const chat = useChat(locale);
  const navigate = useNavigate();
  const search = useSearch({ from: "/" });
  // The seed is captured in state: the param is stripped below, so the search
  // object can no longer carry it on the next render and the seed must survive.
  const [prefill, setPrefill] = useState<string | undefined>(search.q);
  // The seed this page has already consumed (thermo-review: one read per
  // value) — a repeat navigation to the same `q` does not re-seed, and the
  // strip effect below cannot loop.
  const consumedRef = useRef<string | undefined>(search.q);

  useEffect(() => {
    const q = search.q;
    if (q === undefined || q === consumedRef.current) return;
    consumedRef.current = q;
    setPrefill(q);
  }, [search.q]);

  // Consume the param: its `replace` keeps the chat URL clean ("/") whether
  // the reader follows a collection link or reloads, so a refresh cannot
  // re-seed a stale question.
  useEffect(() => {
    if (search.q === undefined) return;
    void navigate({ to: "/", search: {}, replace: true });
  }, [navigate, search.q]);

  return (
    <ChatView
      locale={locale}
      messages={chat.messages}
      busy={chat.busy}
      loadingTranscript={chat.loadingTranscript}
      transcriptTruncated={chat.transcriptTruncated}
      error={chat.error}
      online={chat.online}
      prefill={prefill}
      onSend={chat.send}
      onNewSession={chat.newSession}
    />
  );
}
