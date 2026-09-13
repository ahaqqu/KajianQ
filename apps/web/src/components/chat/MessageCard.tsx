import type { ChatCitation, ChatSessionMessage } from "@app/contracts";
import { AnswerCard } from "./AnswerCard";
import { TracePanel } from "./TracePanel";
import { CitationSheet, useCitationSheet } from "./CitationSheet";
import { FeedbackBar, FlagButton } from "./FeedbackControls";

/**
 * One transcript turn (#11): shaped dispatch only. The user turn is a
 * right-aligned muted bubble; the assistant turn is the answer card
 * (avatar, cited answer, warnings — see AnswerCard) with the anonymous
 * thumbs bar (#13) and the expandable Trace panel beneath it (#12) —
 * rendered at this level because the agentic-limits import cap holds
 * AnswerCard at five imports. The citation sheet is owned here so its
 * footer can carry the trace-anchored flags (#13): the failing element a
 * user reports from the sheet — wrong citation, bad machine translation,
 * questionable grade — anchors to the label the server-derived frame showed.
 */
export function MessageCard({ message }: { message: ChatSessionMessage }) {
  const sheet = useCitationSheet();
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
  const openCitation = (citation: ChatCitation) => sheet.open(citation);
  return (
    <>
      <AnswerCard message={message} onOpenCitation={openCitation} />
      <FeedbackBar messageId={message.id} />
      <TracePanel trace={message.trace} messageId={message.id} />
      {sheet.active !== null && (
        <CitationSheet citation={sheet.active} onClose={sheet.close}>
          <FlagButton
            messageId={message.id}
            anchor={{ type: "citation", category: "wrong_citation", id: sheet.active.label }}
            labelKey="flagWrongCitation"
            testId="flag-citation"
          />
          {sheet.active.machineTranslated && (
            <FlagButton
              messageId={message.id}
              anchor={{
                type: "translation",
                category: "bad_machine_translation",
                id: sheet.active.label,
              }}
              labelKey="flagBadTranslation"
              testId="flag-translation"
            />
          )}
          {sheet.active.grade !== undefined && (
            <FlagButton
              messageId={message.id}
              anchor={{ type: "grade", category: "questionable_grade", id: sheet.active.label }}
              labelKey="flagQuestionableGrade"
              testId="flag-grade"
            />
          )}
        </CitationSheet>
      )}
    </>
  );
}
