import { adminTracePayload } from "../lib/admin-detail";
import { isTraceRowId, traceAccessSummary } from "../lib/admin-query";
import { withAdminRead } from "../lib/admin-route";
import { newRouter } from "../lib/guard";

/**
 * GET /admin/v1/traces/:id and .../raw — one answer's trace, in full (ADR-0064).
 *
 * The detail is the structured view: totals over every provider call, the per-call
 * list, and the Trace frame derived by the same server-side derivation the chat
 * panel uses. The raw route is the persisted trace verbatim, served as a download —
 * the operator's escape hatch when the structured view is what looks wrong.
 *
 * An id the `answer_traces` uuid column cannot hold and an id that names no row are
 * one answer: `404 not_found`. Both routes record the read (an opaque row id, never
 * content) before serving.
 */
export const adminTraceRoutes = newRouter()
  .get("/admin/v1/traces/:id", async (c): Promise<Response> => {
    const traceId = c.req.param("id");
    const context = await withAdminRead(c, "traces.detail", () =>
      isTraceRowId(traceId)
        ? { summary: traceAccessSummary(traceId) }
        : { response: c.json({ error: "not_found" }, 404) },
    );
    if (context instanceof Response) return context;
    const payload = await adminTracePayload({
      store: context.store,
      traceId,
      warn: context.warn,
    });
    if (payload === null) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(payload.detail);
  })
  .get("/admin/v1/traces/:id/raw", async (c): Promise<Response> => {
    const traceId = c.req.param("id");
    const context = await withAdminRead(c, "traces.raw", () =>
      isTraceRowId(traceId)
        ? { summary: traceAccessSummary(traceId) }
        : { response: c.json({ error: "not_found" }, 404) },
    );
    if (context instanceof Response) return context;
    const record = await context.store.runStore(context.store.fullStore.getAdminTrace(traceId));
    if (record === null) return c.json({ error: "not_found" }, 404);
    // The persisted trace verbatim: this is the artifact itself, not a projection
    // of it, so an operator can diff it against a fix.
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", `attachment; filename="trace-${traceId}.json"`);
    return c.json(record.trace);
  });
