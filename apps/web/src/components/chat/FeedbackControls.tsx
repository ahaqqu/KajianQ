import { useState } from "react";
import type { FeedbackAnchor } from "@app/contracts";
import type { FeedbackPayload } from "../../lib/feedback";
import { sendFeedback } from "../../lib/feedback";
import { t, useLocale, type Locale } from "../../lib/i18n";

/**
 * The feedback affordances (#13, ADR-0007): anonymous thumbs on the answer
 * (FeedbackBar) and one-tap trace-anchored flags (FlagButton). Zero friction —
 * the anonymous session the chat already holds is the only credential, the
 * tap posts immediately, and the sent state is shown inline (the report is
 * recorded, never a silent no-op). Sent/error is component-local: a report is
 * one-shot per affordance, so no client cache is needed (server state stays
 * with the API; spec §3.1).
 */

/** One-shot POST with inline idle→sent/error state, shared by both shapes. */
function useSendFeedback(messageId: string): {
  send: (payload: FeedbackPayload) => void;
  sent: boolean;
  failed: boolean;
} {
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = (payload: FeedbackPayload) => {
    setFailed(false);
    sendFeedback(messageId, payload)
      .then(() => setSent(true))
      .catch(() => {
        // A failed report must be retappable, never a dead button.
        setFailed(true);
      });
  };
  return { send, sent, failed };
}

const FLAG_BUTTON =
  "inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/** Thumbs up/down for one answer; the tap stores against the answer's trace. */
export function FeedbackBar({ messageId }: { messageId: string }) {
  const locale: Locale = useLocale();
  const { send, sent, failed } = useSendFeedback(messageId);
  if (sent) {
    return (
      <p data-testid="feedback-thanks" className="ml-10 mt-1 text-xs text-muted-foreground">
        {t(locale, "feedbackThanks")}
      </p>
    );
  }
  return (
    <div
      className="ml-10 mt-1 flex items-center gap-1.5"
      role="group"
      aria-label={t(locale, "feedbackAria")}
    >
      <button
        type="button"
        data-testid="feedback-up"
        aria-label={t(locale, "feedbackUp")}
        className={FLAG_BUTTON}
        onClick={() => send({ rating: "up" })}
      >
        <ThumbUp />
        {t(locale, "feedbackUp")}
      </button>
      <button
        type="button"
        data-testid="feedback-down"
        aria-label={t(locale, "feedbackDown")}
        className={FLAG_BUTTON}
        onClick={() => send({ rating: "down" })}
      >
        <ThumbUp flipped />
        {t(locale, "feedbackDown")}
      </button>
      {failed && (
        <span data-testid="feedback-error" className="text-xs text-destructive">
          {t(locale, "feedbackError")}
        </span>
      )}
    </div>
  );
}

/**
 * One trace-anchored flag button: `anchor` is the CONTRACT's `FeedbackAnchor`
 * variant (thermo-review B1) carrying the element reference the frames
 * actually showed (a chunk id from the Trace panel, a citation label from the
 * passage sheet); the server re-validates it against the persisted trace
 * (#13) — the client never invents an anchor.
 */
export function FlagButton({
  messageId,
  anchor,
  labelKey,
  testId,
}: {
  messageId: string;
  anchor: FeedbackAnchor;
  labelKey:
    | "flagWrongCitation"
    | "flagIrrelevantChunk"
    | "flagBadTranslation"
    | "flagQuestionableGrade";
  testId: string;
}) {
  const locale: Locale = useLocale();
  const { send, sent, failed } = useSendFeedback(messageId);
  if (sent) {
    return (
      <span data-testid={`${testId}-sent`} className="font-mono text-[10px] text-muted-foreground">
        {t(locale, "feedbackThanks")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid={testId}
        className={FLAG_BUTTON}
        onClick={() => send({ anchor })}
      >
        <FlagIcon />
        {t(locale, labelKey)}
      </button>
      {failed && (
        <span data-testid={`${testId}-error`} className="text-xs text-destructive">
          {t(locale, "feedbackError")}
        </span>
      )}
    </span>
  );
}

function ThumbUp({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={`size-3 ${flipped ? "rotate-180" : ""}`}
    >
      <path d="M7 10v12" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className="size-3"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" strokeLinecap="round" />
    </svg>
  );
}
