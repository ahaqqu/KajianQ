import type { ChatSessionMessage, ChatSessionMessages } from "@app/contracts";
import { t, type Locale } from "./i18n";

/**
 * A conversation as a Markdown file the reader keeps (the history drawer's
 * "download a copy"). It is built from the rehydrated transcript, so it carries
 * exactly what the page shows: each turn, and an answer's cited sources.
 *
 * The file is produced and saved entirely in the browser — no request of its
 * own, no server-side copy, nothing added to the browser's storage. The trace
 * is deliberately absent: this is the conversation the reader had, not the
 * machinery behind it (the trace has its own panel).
 */
export function conversationMarkdown(
  transcript: ChatSessionMessages,
  locale: Locale,
  title: string,
): string {
  const heading = title.trim() === "" ? t(locale, "historyUntitled") : title.trim();
  const lines: string[] = [`# ${heading}`, ""];
  for (const message of transcript.messages) {
    const sources = sourcesOf(message);
    lines.push(`## ${roleLabel(message, locale)}`, "", message.content.trim(), "");
    lines.push(...sources.map((source) => `- ${source}`));
    if (sources.length > 0) lines.push("");
  }
  if (transcript.truncated) lines.push(`_${t(locale, "exportTruncated")}_`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function roleLabel(message: ChatSessionMessage, locale: Locale): string {
  return t(locale, message.role === "user" ? "exportYou" : "exportAssistant");
}

/** An answer's cited sources, each one "label — translation (grade)" as shown. */
function sourcesOf(message: ChatSessionMessage): string[] {
  const citations = message.citations?.citations ?? [];
  return citations.map((citation) => {
    const parts = [citation.label];
    const text = citation.source ?? citation.translation;
    if (text !== undefined && text.trim() !== "") parts.push(text.trim());
    if (citation.grade !== undefined) parts.push(`(${citation.grade})`);
    return parts.join(" — ");
  });
}

/** `kajianq-ayat-kursi-2026-10-26.md`: a readable, filesystem-safe name. */
export function conversationFileName(title: string, at: number): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const date = new Date(at).toISOString().slice(0, 10);
  return `kajianq-${slug === "" ? "percakapan" : slug}-${date}.md`;
}

/** Hands the file to the browser's download machinery. */
export function saveConversationFile(name: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the browser has taken the URL: some engines start the
  // transfer after the click handler returns, and an immediate revoke can
  // cancel the download they were about to make.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
