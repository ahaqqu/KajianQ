import {
  loadProviderConfig,
  modelConfigDrift,
  modelConfigDriftEmpty,
  modelConfigEntries,
  ProviderConfigError,
  type ModelConfigDrift,
  type ModelConfigRecord,
} from "@app/infra";

/**
 * The admin detail's gate on the `model_configs` mirror (ADR-0022 decision 3).
 *
 * The config file is the source of truth and the mirror is derived from it; the admin
 * may only decorate a trace with mirror data while the two agree. This reads the
 * effective config (the deployment's profile applied), derives the rows, reads the
 * mirror, and reports the drift — a caller that receives `current` has the rows the
 * config says the mirror must equal, and one that receives `drift` must refuse the
 * read rather than show a retired model or price as current.
 *
 * A config fault is its own outcome: an unknown profile or a dangling candidate is a
 * wiring-time configuration failure, not a mirror finding, and the route answers it
 * with the unavailable status so the operator is not shown a half-explained page.
 */
export type MirrorRead =
  | { kind: "current"; rows: readonly ModelConfigRecord[] }
  | { kind: "drift"; drift: ModelConfigDrift }
  | { kind: "config"; error: string };

export async function readModelConfigMirror(input: {
  profile: string | undefined;
  list: () => Promise<readonly ModelConfigRecord[]>;
}): Promise<MirrorRead> {
  let entries;
  try {
    entries = modelConfigEntries(loadProviderConfig(input.profile));
  } catch (err) {
    if (err instanceof ProviderConfigError) return { kind: "config", error: err.message };
    throw err;
  }
  const rows = await input.list();
  const drift = modelConfigDrift(entries, rows);
  return modelConfigDriftEmpty(drift) ? { kind: "current", rows } : { kind: "drift", drift };
}
