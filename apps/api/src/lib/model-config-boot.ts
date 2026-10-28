import {
  createLogger,
  loadProviderConfig,
  modelConfigDrift,
  modelConfigDriftEmpty,
  modelConfigEntries,
  ProviderConfigError,
  type Logger,
  type ModelConfigDrift,
  type ProviderConfig,
  type RagStore,
} from "@app/infra";
import { runStoreEffect } from "@app/kajianq-domain";
import { ChatConfigError, createRagStoreFromEnv } from "./chat-wiring";

/**
 * The boot-time `model_configs` sync (ADR-0022 decision 3): make the mirror equal the
 * derived provider config before the process serves, and check it.
 *
 * The result is reported, never thrown on a store fault: a database that is briefly
 * unreachable must not turn a provider-config boot into a crash loop, and the admin
 * detail independently refuses a mirror that disagrees with the config, so the stale
 * state is unreadable rather than silently served. The structured `model_config.*`
 * log lines are the ops signal, and they carry counts and an outcome — never a row's
 * payload.
 *
 * A missing `DATABASE_URL` is the configured "no store" posture, exactly as the
 * scheduled cleanup treats it: skipped and reported as such, not a failure.
 */
export type ModelConfigSyncResult = {
  ok: boolean;
  skipped: boolean;
  /** Derived rows written. */
  synced: number;
  /** Post-sync disagreement, if any; null when the mirror could not be read. */
  drift: ModelConfigDrift | null;
};

export type ModelConfigSyncDeps = {
  /** The effective config; defaults to the checked-in config with this env's profile. */
  config?: ProviderConfig;
  createStore?: (env: Record<string, string | undefined>) => RagStore;
  runStore?: typeof runStoreEffect;
  logger?: Logger;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function syncModelConfigMirror(
  env: Record<string, string | undefined>,
  deps: ModelConfigSyncDeps = {},
): Promise<ModelConfigSyncResult> {
  const logger = deps.logger ?? createLogger({ service: "api", route: "bootstrap" });
  const config = (() => {
    try {
      return deps.config ?? loadProviderConfig(env.PROVIDER_PROFILE);
    } catch (err) {
      if (!(err instanceof ProviderConfigError)) throw err;
      logger.error("model_config.sync_failed", { reason: "config", error: messageOf(err) });
      return null;
    }
  })();
  if (config === null) return { ok: false, skipped: false, synced: 0, drift: null };

  let entries;
  try {
    entries = modelConfigEntries(config);
  } catch (err) {
    if (!(err instanceof ProviderConfigError)) throw err;
    logger.error("model_config.sync_failed", { reason: "derive", error: messageOf(err) });
    return { ok: false, skipped: false, synced: 0, drift: null };
  }

  let store: RagStore;
  try {
    store = (deps.createStore ?? createRagStoreFromEnv)(env);
  } catch (err) {
    if (err instanceof ChatConfigError) {
      logger.warn("model_config.sync_skipped", { missing: err.missing ?? "unknown" });
      return { ok: true, skipped: true, synced: 0, drift: null };
    }
    throw err;
  }

  const runStore = deps.runStore ?? runStoreEffect;
  try {
    await runStore(store.syncModelConfigs(entries));
    const rows = await runStore(store.listModelConfigs());
    const drift = modelConfigDrift(entries, rows);
    if (!modelConfigDriftEmpty(drift)) {
      logger.error("model_config.drift", {
        missing: drift.missing.length,
        unexpected: drift.unexpected.length,
        changed: drift.changed.length,
        inactive: drift.inactive.length,
      });
      return { ok: false, skipped: false, synced: entries.length, drift };
    }
    logger.info("model_config.synced", { rows: entries.length });
    return { ok: true, skipped: false, synced: entries.length, drift: null };
  } catch (err) {
    logger.error("model_config.sync_failed", { reason: "store", error: messageOf(err) });
    return { ok: false, skipped: false, synced: 0, drift: null };
  }
}
