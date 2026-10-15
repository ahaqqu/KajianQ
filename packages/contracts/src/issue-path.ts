/**
 * Render a valibot issue as a `field: message` validation diagnostic — the one
 * home for both halves of that string.
 *
 * Valibot's path holds PathItem OBJECTS, not strings: object and array items
 * carry the property/index in `key`, and a path with nothing nameable states
 * `<body>` rather than inventing a field.
 *
 * A `v.union` (the feedback body's two shapes) reports ONE path-less issue
 * whose nested `issues` carry the real paths, so `describeIssue` reads through
 * to the most specific nested issue that names a field, and the union case
 * names the offending field too; the contract that emits the union issue is
 * untouched.
 *
 * One implementation, shared: the chat body parser, the feedback body parser,
 * and the eval fixture loaders all validate with valibot and render their
 * failure detail through these functions. A second copy of either half is a
 * defect.
 */

/** The shape of a valibot issue this module reads (structural, so it imports nothing). */
export interface ValidationIssue {
  /** Valibot's path: PathItem objects, each carrying its `key`. */
  readonly path?: readonly { readonly key?: unknown }[] | undefined;
  /** The issue's message, already human-readable. */
  readonly message: string;
  /** A union/intersection issue's per-branch issues; absent on a leaf issue. */
  readonly issues?: readonly ValidationIssue[] | undefined;
}

/**
 * The nameable parts of a path, in order: each item's string/number `key`.
 * An unnameable key (absent, object, symbol…) is dropped rather than rendered
 * as `undefined`/`[object Object]`, and so is the EMPTY string — a key of `""`
 * names no field, and rendering it would produce a bare `": message"` prefix
 * instead of the honest `<body>`.
 */
function nameableParts(path: readonly { readonly key?: unknown }[] | undefined): string[] {
  return (path ?? [])
    .map((item) => item.key)
    .filter((key): key is string | number =>
      typeof key === "string" ? key !== "" : typeof key === "number",
    )
    .map(String);
}

/** Render a valibot path as a dotted field path, or `<body>` when it names no field. */
export function issuePath(path: readonly { readonly key?: unknown }[] | undefined): string {
  const parts = nameableParts(path);
  return parts.length > 0 ? parts.join(".") : "<body>";
}

/**
 * The issue a diagnostic should speak about: the issue itself when its own
 * path names a field, otherwise the DEEPEST nested issue that names one —
 * ties broken by valibot's emission order (schema declaration order), so the
 * same body always yields the same diagnostic.
 *
 * Deepest, not first, because a union's early nested issues are branch noise
 * from the shape the body was never going to match: "first path-bearing" would
 * blame a field in the wrong branch for a body whose real defect lies in the
 * branch it does not match. Descent recurses, so a nested union whose own
 * issues are path-less still resolves.
 */
function mostSpecificIssue(issue: ValidationIssue): { issue: ValidationIssue; parts: number } {
  const parts = nameableParts(issue.path).length;
  if (parts > 0) return { issue, parts };
  let best: { issue: ValidationIssue; parts: number } | null = null;
  for (const nested of issue.issues ?? []) {
    const candidate = mostSpecificIssue(nested);
    // Strict `>` keeps the FIRST of equally deep candidates (deterministic).
    if (candidate.parts > 0 && (best === null || candidate.parts > best.parts)) best = candidate;
  }
  return best ?? { issue, parts: 0 };
}

/**
 * Render one valibot issue as `<field>: <message>` — the template every
 * validation diagnostic in the repo uses, so no call site can drift back to a
 * raw join or its own fallback.
 *
 * Mutation: replacing the descent loop with `return { issue, parts };` reddens
 * the union rows.
 */
export function describeIssue(issue: ValidationIssue): string {
  const named = mostSpecificIssue(issue);
  return `${issuePath(named.issue.path)}: ${named.issue.message}`;
}
