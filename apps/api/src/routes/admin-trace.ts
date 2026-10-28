import { adminTracePayload } from "../lib/admin-detail";
import { readModelConfigMirror } from "../lib/admin-model-config";
import { traceReadPlan } from "../lib/admin-query";
import { withAdminRead } from "../lib/admin-route";
import { newRouter } from "../lib/guard";

/**
 * GET /v1/admin/traces/:id and .../raw — one answer's trace, in full (ADR-0064).
 *
 * The detail is the structured view: totals over every provider call, the per-call
 * list with each call's model identity and cost consistency from the
 * `model_configs` mirror, and the Trace frame derived by the same server-side
 * derivation the chat panel uses. The raw route is the persisted trace verbatim,
 * served as a download — the operator's escape hatch when the structured view is
 * what looks wrong, which is why it reads the stored JSONB UNPARSED: a row the
 * current contract rejects is exactly the row the escape hatch exists for.
 *
 * The detail refuses to serve mirror data that disagrees with the provider config
 * (ADR-0022 decision 3). The drift is logged structurally and the read answers 503
 * with no content: a trace decorated with a retired model or price would read as
 * current, which is the silent failure this gate exists to prevent. The raw download
 * stays available because it carries no mirror-derived data.
 *
 * An id the `answer_traces` uuid column cannot hold and an id that names no row are
 * one answer: `404 not_found`. Both routes record the read (an opaque row id, never
 * content) before serving, through the one plan they share.
 */
export const adminTraceRoutes = newRouter()
  .get("/v1/admin/traces/:id", async (c): Promise<Response> => {
    const context = await withAdminRead(c, "traces.detail", () => traceReadPlan(c.req.param("id")));
    if (context instanceof Response) return context;
    const mirror = await readModelConfigMirror({
      profile: c.env.PROVIDER_PROFILE,
      list: () => context.store.runStore(context.store.fullStore.listModelConfigs()),
    });
    if (mirror.kind !== "current") {
      // Counts, never row payloads: the log names how far the mirror is from the
      // config without copying the config's prices into the log stream.
      context.log.error("admin.model_config_drift", {
        outcome: mirror.kind,
        missing: mirror.kind === "drift" ? mirror.drift.missing.length : null,
        unexpected: mirror.kind === "drift" ? mirror.drift.unexpected.length : null,
        changed: mirror.kind === "drift" ? mirror.drift.changed.length : null,
        inactive: mirror.kind === "drift" ? mirror.drift.inactive.length : null,
        error: mirror.kind === "config" ? mirror.error : null,
      });
      return c.json(
        { error: mirror.kind === "config" ? "model_config_unavailable" : "model_config_drift" },
        503,
      );
    }
    const lookup = await adminTracePayload({
      store: context.store,
      traceId: context.read,
      modelConfigs: mirror.rows,
      warn: context.warn,
    });
    if (lookup.kind === "unreadable") {
      // The mirror names a requested call's model but its payload is not the shape the
      // contract reads. Refusing is honest (the model is NOT absent); answering
      // `unresolved` here would print a false sentence about a model the mirror names.
      context.log.error("admin.model_config_unreadable", { row: lookup.key });
      return c.json({ error: "model_config_unavailable" }, 503);
    }
    if (lookup.kind === "missing") return c.json({ error: "not_found" }, 404);
    // The adapter answers a stored trace this contract cannot parse with a `constraint`
    // StoreError; naming that condition is honest, and the raw download still serves
    // the row. A generic 500 would say "we are broken" about a row we can read.
    if (lookup.kind === "unparseable") return c.json({ error: "trace_unparseable" }, 422);
    c.header("Cache-Control", "no-store");
    return c.json(lookup.detail);
  })
  .get("/v1/admin/traces/:id/raw", async (c): Promise<Response> => {
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
