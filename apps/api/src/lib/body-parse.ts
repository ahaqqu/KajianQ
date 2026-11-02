import { describeIssue } from "@app/contracts";
import * as v from "valibot";
import { loggable, readJsonBody, reject, type BodyRejection, type Warn } from "./body";

export type { Warn } from "./body";

/** What a route parser answers: the typed body, or the boundary's one rejection shape. */
export type ParsedBody<TOutput> = { success: true; output: TOutput } | BodyRejection;

/** A schema valibot's `safeParse` accepts: the shared contract schemas. */
type ParseableSchema = Parameters<typeof v.safeParse>[0];

/**
 * The read → schema → reject tail both public write routes share. `readJsonBody`
 * owns the transport boundary; this adds the route's own schema, keeps the
 * schema detail log-only, and passes it through the same sanitizer as every
 * other rejection detail — valibot echoes the received value into its message.
 */
export async function parseJsonBody<TSchema extends ParseableSchema>(
  req: Request,
  { route, schema, log }: { route: string; schema: TSchema; log?: Warn | undefined },
): Promise<ParsedBody<v.InferOutput<TSchema>>> {
  const body = await readJsonBody(req, route, log);
  if (!body.success) return body;
  const parsed = v.safeParse(schema, body.value);
  if (!parsed.success) {
    const detail = loggable(parsed.issues.map(describeIssue).join("; "));
    log?.warn(`${route}.body_invalid`, { detail });
    return reject("invalid_request", detail);
  }
  return { success: true, output: parsed.output };
}
