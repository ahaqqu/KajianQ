import { useChat } from "../lib/use-chat";
import { ChatView } from "./chat/ChatView";

/**
 * The KajianQ chat route (#11): replaces the template home. The hook owns
 * rehydration + streaming state; the view is presentational. The selected
 * locale drives the `language` field sent to /v1/chat (Indonesian default).
 */
export function ChatPage({ locale }: { locale: "id" | "en" }) {
  const chat = useChat(locale);
  return (
    <ChatView
      locale={locale}
      messages={chat.messages}
      busy={chat.busy}
      loadingTranscript={chat.loadingTranscript}
      transcriptTruncated={chat.transcriptTruncated}
      error={chat.error}
      online={chat.online}
      onSend={chat.send}
      onNewSession={chat.newSession}
    />
  );
}
