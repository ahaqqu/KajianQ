import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * The admin screen's one piece of URL state: which answer is open.
 *
 * It lives in the search string rather than in component state because a trace read
 * is something an operator copies into an incident note or a PR body — the link must
 * open the same answer for the next person. `validateSearch` narrows the param to a
 * string (or nothing) before the page sees it, so a hand-edited URL cannot hand the
 * detail view a non-string.
 */
export type AdminSearch = { trace?: string };

export function validateAdminSearch(search: Record<string, unknown>): AdminSearch {
  return typeof search.trace === "string" && search.trace.length > 0 ? { trace: search.trace } : {};
}

/** The open trace's id, and the setter that puts it in the address bar. */
export function useAdminTraceParam(): [string | undefined, (id: string | undefined) => void] {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | undefined) => {
      // `replace` keeps the back button about pages, not about rows: an operator
      // stepping through answers is not building a history of every click.
      void navigate({
        to: "/admin",
        search: id === undefined ? {} : { trace: id },
        replace: true,
      });
    },
    [navigate],
  );
  return [search.trace, select];
}
