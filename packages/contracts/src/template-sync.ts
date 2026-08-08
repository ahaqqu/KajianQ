import * as v from "valibot";

const PathSchema = v.pipe(v.string(), v.minLength(1));

/**
 * Ownership manifest for template sync. Declares the upstream template URL
 * and which paths are template-owned (`overwrite`) vs. project-inherited
 * (`merge`). Unlisted paths are project-owned and never synced.
 */
export const TemplateSyncManifestSchema = v.object({
  upstream: v.pipe(v.string(), v.minLength(1)),
  overwrite: v.array(PathSchema),
  merge: v.array(PathSchema),
});

export type TemplateSyncManifest = v.InferOutput<
  typeof TemplateSyncManifestSchema
>;

/** Parse and validate a template-sync manifest object. */
export function parseTemplateSyncManifest(
  raw: unknown,
): TemplateSyncManifest {
  return v.parse(TemplateSyncManifestSchema, raw);
}

/**
 * Recorded sync state. Stored in `.template-sync.state` (project-owned).
 */
export const TemplateSyncStateSchema = v.object({
  ref: v.pipe(v.string(), v.minLength(1)),
  commit: v.pipe(v.string(), v.minLength(1)),
});

export type TemplateSyncState = v.InferOutput<typeof TemplateSyncStateSchema>;

/** Parse and validate a template-sync state object. */
export function parseTemplateSyncState(raw: unknown): TemplateSyncState {
  return v.parse(TemplateSyncStateSchema, raw);
}
