/**
 * Render a valibot issue as a `field: message` validation diagnostic (#271,
 * #283) — the one home for both halves of that string.
 *
 * Valibot's path holds PathItem OBJECTS, not strings: joining them raw
 * stringified every element as `[object Object]`, so a rejected body's
 * diagnostic named no field at all (`[object Object]: Invalid UUID: Received
 * "en"`). Object and array items carry the property/index in `key`; a path
 * with nothing nameable states `<body>` rather than inventing a field.
 *
 * A `v.union` (the feedback body's two shapes) reports ONE path-less issue
 * whose nested `issues` carry the real paths, so the union's own issue alone
 * reads `<body>: Invalid type: Expected Object but received Object` — the
 * exact symptom #283 exists to remove. `describeIssue` therefore reads
 * through to the most specific nested issue that names a field, so the union
 * case names the offending field too; the contract that emits the union issue
 * is untouched.
 *
 * One implementation, shared: the chat body parser (#271), the feedback body
 * parser (#283), and the eval fixture loaders all validate with valibot and
 * all render their failure detail through these functions. A second copy of
 * either half is a defect — the copies drifted before (the template's
 * body-level fallback was `?` in three of them), and one of them still joined
 * the raw objects.
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
 * names no field, and rendering it produced a bare `": message"` prefix
 * instead of the honest `<body>` (latent: no schema behind the five call
 * sites uses `v.record`/`v.map`/`v.set` on a path that reaches here).
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
 * from the shape the body was never going to match. A malformed anchored flag
 * (`{messageId, anchor: {type: "grade", category: "irrelevant_chunk", id}}`)
 * emits the thumb branch's `rating`-missing issue BEFORE the flag branch's
 * `anchor.category` issue, so "first path-bearing" would blame a missing
 * `rating` for a body whose real defect is the category pairing. Descent
 * recurses, so a nested union whose own issues are path-less still resolves.
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
 * Mutation that reddens the union rows in `issue-path.test.ts` and the
 * feedback route's union row: replace the descent loop with
 * `return { issue, parts };`, which restores
 * `<body>: Invalid type: Expected Object but received Object` for the
 * `rating: "meh"` body.
 */
export function describeIssue(issue: ValidationIssue): string {
  const named = mostSpecificIssue(issue);
  return `${issuePath(named.issue.path)}: ${named.issue.message}`;
}
