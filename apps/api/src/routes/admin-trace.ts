import { adminTracePayload } from "../lib/admin-detail";
import { traceReadPlan } from "../lib/admin-query";
import { withAdminRead } from "../lib/admin-route";
import { newRouter } from "../lib/guard";

/**
 * GET /admin/v1/traces/:id and .../raw — one answer's trace, in full (ADR-0064).
 *
 * The detail is the structured view: totals over every provider call, the per-call
 * list, and the Trace frame derived by the same server-side derivation the chat
 * panel uses. The raw route is the persisted trace verbatim, served as a download —
 * the operator's escape hatch when the structured view is what looks wrong, which is
 * why it reads the stored JSONB UNPARSED: a row the current contract rejects is
 * exactly the row the escape hatch exists for.
 *
 * An id the `answer_traces` uuid column cannot hold and an id that names no row are
 * one answer: `404 not_found`. Both routes record the read (an opaque row id, never
 * content) before serving, through the one plan they share.
 */
export const adminTraceRoutes = newRouter()
  .get("/admin/v1/traces/:id", async (c): Promise<Response> => {
    const context = await withAdminRead(c, "traces.detail", () => traceReadPlan(c.req.param("id")));
    if (context instanceof Response) return context;
    const lookup = await adminTracePayload({
      store: context.store,
      traceId: context.read,
      warn: context.warn,
    });
    if (lookup.kind === "missing") return c.json({ error: "not_found" }, 404);
    // The adapter answers a stored trace this contract cannot parse with a `constraint`
    // StoreError; naming that condition is honest, and the raw download still serves
    // the row. A generic 500 would say "we are broken" about a row we can read.
    if (lookup.kind === "unparseable") return c.json({ error: "trace_unparseable" }, 422);
    c.header("Cache-Control", "no-store");
    return c.json(lookup.detail);
  })
  .get("/admin/v1/traces/:id/raw", async (c): Promise<Response> => {
    const context = await withAdminRead(c, "traces.raw", () => traceReadPlan(c.req.param("id")));
    if (context instanceof Response) return context;
    const record = await context.store.runStore(
      context.store.fullStore.getAdminTraceRaw(context.read),
    );
    if (record === null) return c.json({ error: "not_found" }, 404);
    // The persisted trace verbatim: this is the artifact itself, not a projection
    // of it, so an operator can diff it against a fix.
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", `attachment; filename="trace-${context.read}.json"`);
    return c.json(record.trace);
  });
