/**
 * Render a valibot issue's `path` as a dotted field path (#271, #283).
 *
 * Valibot's path holds PathItem OBJECTS, not strings: joining them raw
 * stringified every element as `[object Object]`, so a rejected body's
 * diagnostic named no field at all (`[object Object]: Invalid UUID: Received
 * "en"`). Object and array items carry the property/index in `key`; a path
 * with nothing nameable states `<body>` rather than inventing a field.
 *
 * One implementation, shared: the chat body parser (#271), the feedback body
 * parser (#283), and the eval fixture loaders all validate with valibot and
 * all render their failure detail through this function. A second copy of the
 * rendering is a defect — the copies drifted before, and one of them still
 * joined the raw objects.
 */
export function issuePath(path: readonly { key?: unknown }[] | undefined): string {
  const parts = (path ?? [])
    .map((item) =>
      typeof item.key === "string" || typeof item.key === "number" ? String(item.key) : null,
    )
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(".") : "<body>";
}
