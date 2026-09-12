/**
 * The one owner of the Hono→OpenAPI path normalization (thermo-review B3):
 * Hono's route table uses `:param`; hono-openapi documents `{param}`. The
 * route-coverage test (apps/api/src/app.test.ts) and the quick local gate
 * (scripts/openapi-check.mjs) both compare routes against the generated doc
 * through THIS function, so the two checks cannot drift apart — a wildcard
 * or multi-segment param learned here is learned by both.
 */

/** Normalize a Hono route path to its OpenAPI `{param}` form. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
