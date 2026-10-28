import * as v from "valibot";
import { ChatTraceFrameSchema } from "./chat-trace";
import { TraceProviderCallSchema, TraceTotalsSchema } from "./trace";

/**
 * The admin surface's wire shapes — the read-only Trace browser's login, list and
 * detail payloads.
 *
 * It is deliberately **not** part of the public OpenAPI document: no admin path is
 * described there, so a client generated from `/openapi.json` cannot see the
 * surface at all. The contracts still live here, beside every other boundary
 * shape, because the API validates with them and the admin UI builds its requests
 * from them — one owner for what crosses the wire.
 *
 * The shapes carry **content** (question and answer text), which the API reads
 * from `chat_messages`, never reconstructs from a trace. Nothing in this module is
 * an access log: the log's summary type has no field for content on purpose, so a
 * filter summary cannot be built out of a question even by accident.
 */

const nonEmpty = () => v.pipe(v.string(), v.minLength(1));

/** The uniform failure body: every auth miss answers this shape with a 401. */
export const AdminErrorSchema = v.object({ error: nonEmpty() });

export type AdminError = v.InferOutput<typeof AdminErrorSchema>;

/**
 * The one credential the admin surface accepts (env-configured, ADR-0064). The
 * length ceiling is the boundary's own bound on a body the server will hash, not
 * a hint about the credential: an over-long body is the same uniform 401 as a
 * wrong password, so the contract miss cannot reveal a credential's presence.
 */
export const AdminLoginRequestSchema = v.object({
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});

export type AdminLoginRequest = v.InferOutput<typeof AdminLoginRequestSchema>;

/**
 * The session probe's answer. `authenticated` is state, never a capability claim:
 * the httpOnly cookie is the credential. `csrfToken` is the value the login POST
 * must echo in its `X-CSRF-Token` header — delivered in the body because the
 * cookie itself is httpOnly, which is what keeps a cross-site page from reading it.
 */
export const AdminSessionSchema = v.object({
  authenticated: v.boolean(),
  csrfToken: v.pipe(v.string(), v.minLength(1)),
});

export type AdminSession = v.InferOutput<typeof AdminSessionSchema>;

/**
 * One trace in the list: the message's own identity, its question and answer
 * **as the transcript stores them**, and the trace-derived facts an operator
 * searches on (routed intent, models, refusal, filter relaxation) plus that
 * message's totals. `traceId` is the trace row's own id — the stable deep link.
 */
export const AdminTraceListItemSchema = v.object({
  traceId: nonEmpty(),
  messageId: nonEmpty(),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  question: v.string(),
  answer: v.string(),
  intent: v.optional(nonEmpty()),
  /** Distinct model identities, in first-call order (opaque ids). */
  models: v.array(nonEmpty()),
  refused: v.boolean(),
  filterRelaxed: v.boolean(),
  totals: TraceTotalsSchema,
});

export type AdminTraceListItem = v.InferOutput<typeof AdminTraceListItemSchema>;

/** One page of the list, server-side: `total` counts every matching row. */
export const AdminTraceListSchema = v.object({
  items: v.array(AdminTraceListItemSchema),
  page: v.pipe(v.number(), v.integer(), v.minValue(1)),
  pageSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
  total: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type AdminTraceList = v.InferOutput<typeof AdminTraceListSchema>;

/** A model config's price: micro-USD per million tokens, the unit the provider
 * config states and the adapter's cost arithmetic reads. Exported because the admin
 * detail re-reads a mirror row's payload with it: an unreadable price is refused, not
 * reported as a model the config does not name. */
export const ModelPriceSchema = v.object({
  in: v.pipe(v.number(), v.integer(), v.minValue(0)),
  out: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * One `model_configs` row that publishes a call's model id. An id can be carried by
 * more than one row on different terms (the free-tier and paid-terms embedding rows
 * share a model id), so every candidate is listed; the browser never has to trust a
 * provider this payload picked silently.
 */
export const AdminCallModelMatchSchema = v.object({
  provider: nonEmpty(),
  /** Roles whose chain includes this model, sorted. */
  roles: v.array(nonEmpty()),
  priceMicroUsdPerMTok: ModelPriceSchema,
  /** ceil((tokensIn×in + tokensOut×out) / 1e6) — the provider adapter's own cost
   * arithmetic, so an equality here means "this row's price reproduces the figure
   * the trace recorded", not "a second cost was computed a different way". */
  computedCostMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** True when `computedCostMicroUsd` equals the call's recorded `costMicroUsd`. */
  consistent: v.boolean(),
});

export type AdminCallModelMatch = v.InferOutput<typeof AdminCallModelMatchSchema>;

/**
 * A provider call's model identity and pricing consistency, read from the
 * `model_configs` mirror. The call's recorded `costMicroUsd` stays the figure the
 * browser shows; this half only says whether the config's price accounts for it and
 * under which provider row.
 *
 * `status` is a closed vocabulary: `consistent` when a mirrored price reproduces the
 * recorded figure, `mismatch` when the model is mirrored but no price does, and
 * `unresolved` when no mirror row names the id. A trace naming a model the config no
 * longer carries is not mirror drift — the mirror is current and the trace is old —
 * so this is a reported state, never a failed read.
 */
export const AdminCallModelConfigSchema = v.object({
  status: v.picklist(["consistent", "mismatch", "unresolved"]),
  matches: v.array(AdminCallModelMatchSchema),
});

export type AdminCallModelConfig = v.InferOutput<typeof AdminCallModelConfigSchema>;

/** One recorded provider call plus the mirror's model-identity half. */
export const AdminTraceCallSchema = v.object({
  ...TraceProviderCallSchema.entries,
  modelConfig: AdminCallModelConfigSchema,
});

export type AdminTraceCall = v.InferOutput<typeof AdminTraceCallSchema>;

/**
 * One trace in full: the same message fields as the list, the per-message totals
 * and the per-provider-call list (the embedding call included), each call carrying
 * its model identity and cost consistency from the `model_configs` mirror, and the
 * two-layer Trace frame derived SERVER-SIDE by the same
 * `deriveTraceFrame`/`TraceBody` derivation the user-facing panel renders — never a
 * second renderer. The raw persisted trace is a separate download, so this payload
 * never ships the raw event stream.
 */
export const AdminTraceDetailSchema = v.object({
  // The detail's message half IS the list item: one declaration, so a fact added
  // to one payload cannot be missing from the other.
  ...AdminTraceListItemSchema.entries,
  calls: v.array(AdminTraceCallSchema),
  frame: ChatTraceFrameSchema,
});

export type AdminTraceDetail = v.InferOutput<typeof AdminTraceDetailSchema>;

/** The default page the list answers when the query names none. */
export const ADMIN_PAGE_SIZE_DEFAULT = 20;

/** The largest page the list will serve — a bound, not a client convention. */
export const ADMIN_PAGE_SIZE_MAX = 50;

/** The free-text ceiling; a longer query is a 400, never a truncated search. */
export const ADMIN_QUERY_TEXT_MAX = 200;

const epochsMs = () => v.optional(v.pipe(v.string(), v.regex(/^\d{1,15}$/), v.transform(Number)));

/**
 * The list's query string, parsed from every value as the string the URL carries:
 * `page`/`pageSize` are bounded here (`ADMIN_PAGE_SIZE_MAX`), the date range is
 * epoch milliseconds, and the booleans are the literal `true`/`false`. An unknown
 * or malformed value fails the parse, which the route answers as a 400 — a filter
 * that silently degrades to "no filter" would show an operator every message while
 * they believe they are looking at a narrowed set.
 */
export const AdminTraceQuerySchema = v.object({
  q: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(ADMIN_QUERY_TEXT_MAX))),
  from: epochsMs(),
  to: epochsMs(),
  intent: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  model: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  refused: v.optional(v.picklist(["true", "false"])),
  filterRelaxed: v.optional(v.picklist(["true", "false"])),
  minLatencyMs: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,12}$/), v.transform(Number), v.integer(), v.minValue(0)),
  ),
  minCostMicroUsd: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,15}$/), v.transform(Number), v.integer(), v.minValue(0)),
  ),
  page: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number), v.integer(), v.minValue(1)),
    "1",
  ),
  pageSize: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,3}$/),
      v.transform(Number),
      v.integer(),
      v.minValue(1),
      v.maxValue(ADMIN_PAGE_SIZE_MAX),
    ),
    String(ADMIN_PAGE_SIZE_DEFAULT),
  ),
});

export type AdminTraceQuery = v.InferOutput<typeof AdminTraceQuerySchema>;
