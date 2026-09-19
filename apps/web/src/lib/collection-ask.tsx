import { Link } from "@tanstack/react-router";

/**
 * The collection page's "Ask about this source" affordance (#175): a typed
 * TanStack `Link` into the chat route with the entry's per-locale question as
 * the `q` search param. Pre-fill only — the chat seeds its composer draft from
 * the param and never auto-sends; the param never touches the chat
 * session/server contract (ADR-0040).
 *
 * Rendered only for available entries: planned entries are registered work, and
 * linking one into an answer would imply a source the corpus does not have
 * (CollectionPage owns that guard, plus the i18n label).
 *
 * Lives in the `lib/` leaf and is re-exported through `components/ui.tsx` so
 * `CollectionPage` stays under the agentic-limits import cap — the same
 * arrangement as `NavLinks` (see `ui.tsx`).
 */
export function AskAboutLink({ label, question }: { label: string; question: string }) {
  return (
    <Link
      to="/"
      search={{ q: question }}
      data-testid="collection-ask"
      className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
    </Link>
  );
}
