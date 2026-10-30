import type { ChatCitation, ChatSessionMessage } from "@app/contracts";
import { AnswerCard } from "./AnswerCard";
import { TracePanel } from "./TracePanel";
import { CitationSheet, useCitationSheet } from "./CitationSheet";
import { chainGradeAnchor, FeedbackBar, FlagButton } from "./FeedbackControls";

/**
 * One transcript turn: shaped dispatch only. The user turn is a right-aligned
 * muted bubble; the assistant turn is the answer card (avatar, cited answer,
 * warnings — see AnswerCard) with the anonymous thumbs bar and the expandable
 * Trace panel beneath it — rendered at this level because the agentic-limits
 * import cap leaves AnswerCard no room for them. The citation sheet is owned
 * here so its footer can carry the trace-anchored flags: the failing element a
 * user reports from the sheet — wrong citation, bad machine translation,
 * questionable grade — anchors to the identifier the server-derived frame
 * showed. A questionable grade on a chained passage anchors to the specific
 * row's position and verdict, never to the passage's flattened grade.
 *
 * `persisted` gates every feedback affordance: the live turn is rendered from
 * `send()` onward under a client-local placeholder id that names no row until
 * `meta` re-keys it, and a report posted against that placeholder 404s.
 */
export function MessageCard({
  message,
  persisted,
}: {
  message: ChatSessionMessage;
  persisted: boolean;
}) {
  const sheet = useCitationSheet();
  const active = sheet.active;
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
  const flatGrade = active !== null && (active.chains === undefined || active.chains.length === 0);
  return (
    <>
      <AnswerCard message={message} onOpenCitation={openCitation} />
      <FeedbackBar messageId={message.id} persisted={persisted} />
      <TracePanel trace={message.trace} messageId={message.id} persisted={persisted} />
      {active !== null && (
        <CitationSheet
          citation={active}
          onClose={sheet.close}
          renderChainFlag={(chain, index) => (
            <FlagButton
              messageId={message.id}
              persisted={persisted}
              anchor={chainGradeAnchor(active, chain, index)}
              labelKey="flagQuestionableGrade"
              testId={`flag-chain-${index}`}
            />
          )}
        >
          <FlagButton
            messageId={message.id}
            persisted={persisted}
            anchor={{ type: "citation", category: "wrong_citation", id: active.label }}
            labelKey="flagWrongCitation"
            testId="flag-citation"
          />
          {active.machineTranslated && (
            <FlagButton
              messageId={message.id}
              persisted={persisted}
              anchor={{
                type: "translation",
                category: "bad_machine_translation",
                id: active.label,
              }}
              labelKey="flagBadTranslation"
              testId="flag-translation"
            />
          )}
          {flatGrade && active.chainsUnread !== true && active.grade !== undefined && (
            <FlagButton
              messageId={message.id}
              persisted={persisted}
              anchor={{ type: "grade", category: "questionable_grade", id: active.label }}
              labelKey="flagQuestionableGrade"
              testId="flag-grade"
            />
          )}
        </CitationSheet>
      )}
    </>
  );
}
