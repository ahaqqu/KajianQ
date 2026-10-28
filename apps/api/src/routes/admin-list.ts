import { adminTraceListOf } from "../lib/admin-detail";
import { parseAdminListRead, type AdminListRead } from "../lib/admin-query";
import { withAdminRead, type AdminReadPlan } from "../lib/admin-route";
import { newRouter } from "../lib/guard";

/**
 * GET /admin/v1/traces — the failure-search list (ADR-0064): every assistant
 * answer joined to its persisted trace, filtered and paginated by the store.
 *
 * The query is parsed INSIDE the guarded resolve, so a malformed one is answered
 * only after the credential check: an unauthenticated caller learns nothing from it.
 * The one parse also produces the store filter, the page window and the access
 * summary, so the route reads on with those instead of re-deriving them.
 *
 * The response is parsed against its contract before it ships, exactly as the
 * public frames are. The access record is written before the rows are read, and a
 * filtered read's record contains the filter dimensions but never the search text.
 */
export const adminListRoutes = newRouter().get("/admin/v1/traces", async (c): Promise<Response> => {
  const context = await withAdminRead<AdminListRead>(
    c,
    "traces.list",
    (): AdminReadPlan<AdminListRead> => {
      const read = parseAdminListRead(new URL(c.req.url).searchParams);
      if (read === null) return { refuse: { status: 400, error: "invalid_request" } };
      return { summary: read.summary, read };
    },
  );
  if (context instanceof Response) return context;

  const { store } = context;
  const { query, filter, page } = context.read;
  const result = await store.runStore(store.fullStore.listAdminTraces(filter, page));
  c.header("Cache-Control", "no-store");
  return c.json(adminTraceListOf({ rows: result.rows, query, total: result.total }));
});
