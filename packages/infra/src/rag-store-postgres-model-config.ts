import { Effect } from "effect";
import type {
  ModelConfigEntry,
  ModelConfigRecord,
  RagStoreModelConfig,
} from "./rag-store-model-config-seam";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * The `model_configs` mirror's Postgres methods (ADR-0022 decision 3).
 *
 * `syncModelConfigs` is ONE transaction of two statements: an upsert of the derived
 * rows keyed by the table's unique `(role, provider, model_id)`, then a delete of every
 * row the derived set does not name. The upsert (rather than a delete-everything
 * followed by inserts) is what makes two booting processes converge instead of
 * colliding on the unique constraint: a concurrent run either sees the previous
 * payload and updates it, or finds its own key already present. The final delete is
 * the other half of "derived": a model removed from the config has no row left
 * claiming to be current. Both statements run on one connection inside `BEGIN …
 * COMMIT`, so a failure leaves the previous mirror intact rather than a partial set.
 *
 * The payload is bound as one JSONB parameter and expanded by `jsonb_to_recordset`,
 * never spliced into the SQL text.
 */

type Row = {
  role: string;
  provider: string;
  model_id: string;
  config: unknown;
  active: unknown;
  updated_at_ms: unknown;
};

/** The derived rows as the one JSONB parameter both statements read. */
function payloadOf(entries: readonly ModelConfigEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      role: entry.role,
      provider: entry.provider,
      model_id: entry.modelId,
      config: entry.config,
    })),
  );
}

function recordOf(row: Row): ModelConfigRecord {
  return {
    role: row.role,
    provider: row.provider,
    modelId: row.model_id,
    config:
      row.config !== null && typeof row.config === "object"
        ? (row.config as Record<string, unknown>)
        : {},
    active: row.active === true,
    updatedAt: Number(row.updated_at_ms),
  };
}

export function postgresModelConfigMethods(
  sql: SqlRunner,
): Pick<RagStoreModelConfig, "syncModelConfigs" | "listModelConfigs"> {
  return {
    syncModelConfigs(entries) {
      const payload = payloadOf(entries);
      return Effect.asVoid(
        sqlEffect(sql, () =>
          sql.transaction([
            sql`
              INSERT INTO model_configs (role, provider, model_id, config, active, updated_at)
              SELECT x.role, x.provider, x.model_id, x.config, true, now()
              FROM jsonb_to_recordset(${payload}::jsonb)
                AS x(role text, provider text, model_id text, config jsonb)
              ON CONFLICT (role, provider, model_id)
              DO UPDATE SET config = EXCLUDED.config, active = true, updated_at = now()
            `,
            sql`
              DELETE FROM model_configs m
              WHERE NOT EXISTS (
                SELECT 1
                FROM jsonb_to_recordset(${payload}::jsonb)
                  AS x(role text, provider text, model_id text, config jsonb)
                WHERE x.role = m.role
                  AND x.provider = m.provider
                  AND x.model_id = m.model_id
              )
            `,
          ]),
        ),
      );
    },

    listModelConfigs() {
      return sqlEffect(sql, async () => {
        const rows = (await sql.query(`
          SELECT role, provider, model_id, config, active,
                 (extract(epoch FROM updated_at) * 1000)::double precision AS updated_at_ms
          FROM model_configs
          ORDER BY role, provider, model_id
        `)) as Row[];
        return rows.map(recordOf);
      });
    },
  };
}
