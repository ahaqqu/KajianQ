import type { ChatSessionMessage } from "@app/contracts";
import { AnswerCard } from "./AnswerCard";

/**
 * One transcript turn (#11): shaped dispatch only. The user turn is a
 * right-aligned muted bubble; the assistant turn is the answer card
 * (avatar, cited answer, warnings — see AnswerCard).
 */
export function MessageCard({ message }: { message: ChatSessionMessage }) {
  if (message.role === "user") {
    return (
      <article
        data-testid="message-user"
        className="ml-auto w-fit max-w-[85%] rounded-xl bg-card px-4 py-2.5"
      >
        <p className="whitespace-pre-wrap text-[15px] text-card-foreground">{message.content}</p>
      </article>
    );
  }
  return <AnswerCard message={message} />;
}
