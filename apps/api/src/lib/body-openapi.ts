import { resolver } from "hono-openapi";
import { rejectionDescription } from "./body";

/** Any schema the OpenAPI resolver accepts — the route's own error contract. */
type ErrorSchema = Parameters<typeof resolver>[0];

/**
 * The 400/413/415 body-rejection responses every public write route publishes.
 * One factory over the boundary's code/status map, so the contract has one
 * statement; the route passes its own error schema, so the document stays
 * truthful about the payload that route answers.
 */
export function bodyRejectionResponses(errorSchema: ErrorSchema) {
  const response = (status: 400 | 413 | 415) => ({
    description: rejectionDescription(status),
    content: { "application/json": { schema: resolver(errorSchema) } },
  });
  return { 400: response(400), 413: response(413), 415: response(415) };
}
