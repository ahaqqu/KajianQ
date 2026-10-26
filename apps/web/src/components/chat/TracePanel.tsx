import { useState } from "react";
import type { ChatTraceFrame } from "@app/contracts";
import { t, useLocale } from "../../lib/i18n";
import { BookIcon, ChevronIcon } from "../icons";
import { TraceBody } from "./TraceBody";

/**
 * The trace disclosure under an answer: the reference's full-width row — book
 * mark, "See how this answer came together", caret — opening the two-layer
 * body (`TraceBody`). Rendered only when the message carries a trace frame; a
 * message without one (user turns, degraded traces) shows no affordance, by
 * data.
 */
export function TracePanel({
  trace,
  messageId,
  persisted,
}: {
  trace: ChatTraceFrame | undefined;
  messageId: string;
  persisted: boolean;
}) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  if (trace === undefined) return null;

  return (
    <div data-testid="trace-panel" className="mt-1">
      <button
        type="button"
        data-testid="trace-toggle"
        aria-expanded={open}
        aria-controls="trace-body"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left text-sm text-muted-foreground hover:bg-card hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BookIcon className="size-4 shrink-0 text-accent" />
        <span>{t(locale, "traceToggle")}</span>
        <ChevronIcon
          className={`ml-auto size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <TraceBody trace={trace} messageId={messageId} persisted={persisted} />}
    </div>
  );
}
