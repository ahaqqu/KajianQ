import { AdminTraceListSchema, type AdminTraceList } from "@app/contracts";
import * as v from "valibot";
import { newRouter } from "../lib/guard";
import { accessSummaryOf, adminFilterOf, pageWindowOf, parseAdminQuery } from "../lib/admin-query";
import { withAdminRead } from "../lib/admin-route";

/**
 * GET /admin/v1/traces — the failure-search list (ADR-0064): every assistant
 * answer joined to its persisted trace, filtered and paginated by the store.
 *
 * The response is parsed against its contract before it ships, exactly as the
 * public frames are. The access record is written before the rows are read, and a
 * filtered read's record contains the filter dimensions but never the search text.
 */
export const adminListRoutes = newRouter().get("/admin/v1/traces", async (c): Promise<Response> => {
  // The query is parsed inside the summarizer, after authentication: an
  // unauthenticated caller learns nothing from a malformed one.
  const query = parseAdminQuery(new URL(c.req.url).searchParams);
  const context = await withAdminRead(c, "traces.list", () =>
    query.ok
      ? { summary: accessSummaryOf(query.query) }
      : { response: c.json({ error: "invalid_request" }, 400) },
  );
  if (context instanceof Response) return context;
  // Authentication passed, so the parse above either succeeded or answered 400 —
  // the narrowed branch keeps the type honest without a second read of the query.
  if (!query.ok) return c.json({ error: "invalid_request" }, 400);

  const { store } = context;
  const result = await store.runStore(
    store.fullStore.listAdminTraces(adminFilterOf(query.query), pageWindowOf(query.query)),
  );
  const payload: AdminTraceList = {
    items: result.rows.map((row) => ({
      traceId: row.traceId,
      messageId: row.messageId,
      createdAt: row.createdAt,
      question: row.question,
      answer: row.answer,
      ...(row.intent !== null ? { intent: row.intent } : {}),
      models: [...row.models],
      refused: row.refused,
      filterRelaxed: row.filterRelaxed,
      totals: row.totals,
    })),
    page: query.query.page,
    pageSize: query.query.pageSize,
    total: result.total,
  };
  c.header("Cache-Control", "no-store");
  return c.json(v.parse(AdminTraceListSchema, payload));
});
