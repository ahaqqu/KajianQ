import { Pool } from "pg";
import type { SqlRunner } from "./rag-store-postgres-errors";
import { createPostgresRagStore } from "./rag-store-postgres";
import type { PostgresRagStoreOptions } from "./rag-store-postgres-logging";
import type { RagStore } from "./rag-store";

/**
 * The Postgres wire driver for the `RagStore` adapter (#181, ADR-0044): a
 * `pg` `Pool` adapted to the adapter's structural `SqlRunner` seam. This module
 * is the ONE place the repository imports a database client (ADR-0008: engine
 * code never holds a driver; only the adapter and the migrations do), and it
 * is therefore exempt from the boundary gate's DB-client rule alongside the
 * adapter's own integration test.
 *
 * Why `pg` (node-postgres) and not the provider's serverless HTTP transport:
 * the self-hosted Postgres on the netcup VPS speaks plain TCP, not a hosted
 * query endpoint, and the migration's point is to stop depending on a hosting
 * vendor's transport (ADR-0043/ADR-0044). node-postgres is the driver the
 * previous serverless transport was a drop-in replacement for, so the seam
 * shape — tagged template, `query(text, params)`, a batched `transaction` — is
 * unchanged and the adapter's SQL composes exactly as before.
 *
 * Lazy queries. The adapter was written against a driver whose tagged-template
 * result is a LAZY thenable: `.then`/`.catch`/`.finally` each fire the query,
 * so `sqlEffect` can adopt it with exactly one `Promise.resolve(...)` and
 * `transaction([...])` can collect un-executed statements into one round trip
 * (see `sqlEffect`'s doc comment for the double-execution hazard it guards).
 * node-postgres executes immediately, which would break that atomicity: the
 * two INSERTs of `createSession` would run on two pooled connections, outside
 * any transaction. {@link DeferredQuery} reproduces the lazy contract on top of
 * the pool, so `transaction` can acquire one client, `BEGIN`, run each
 * statement in order and `COMMIT` — the same atomicity the hosted transport
 * gave for free.
 */

/** One not-yet-executed statement: its text and its bound values. */
type Statement = { text: string; values: unknown[] };

/**
 * A lazy query: it executes only when something consumes it, and each of
 * `then`/`catch`/`finally` starts the execution (the contract the adapter's
 * `sqlEffect` is written against). `transaction` reads {@link statements}
 * instead of consuming the thenable, so a statement can be batched without
 * ever running standalone.
 */
class DeferredQuery implements PromiseLike<unknown[]> {
  readonly statements: readonly Statement[];

  constructor(
    private readonly run: (s: Statement) => Promise<unknown[]>,
    statement: Statement,
  ) {
    this.statements = [statement];
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const statement = this.statements[0]!;
    return this.run(statement).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<unknown[] | TResult> {
    const statement = this.statements[0]!;
    return this.run(statement).catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<unknown[]> {
    const statement = this.statements[0]!;
    return this.run(statement).finally(onfinally ?? undefined);
  }
}

/** Build the placeholder text (`$1, $2, …`) for one tagged-template call. */
function templateText(strings: readonly string[], values: readonly unknown[]): string {
  if (values.length === 0) return strings.join("");
  return (
    strings.slice(0, -1).reduce((acc, part, i) => `${acc}${part}$${i + 1}`, "") + strings.at(-1)
  );
}

/** True when `value` is one of this module's lazy tagged-template results. */
function isDeferred(value: unknown): value is DeferredQuery {
  return value instanceof DeferredQuery;
}

/**
 * Adapt a `pg` pool to the adapter's `SqlRunner` seam. The returned function
 * is the tagged-template call (`sql\`SELECT ${x}\``); `.query` takes text +
 * positional params; `.transaction` runs an array of *un-executed* statements
 * on one connection inside `BEGIN … COMMIT` and resolves one row array per
 * statement, in order (the shape `cleanupExpiredSessions` reads).
 */
export function postgresSqlRunner(pool: Pool): SqlRunner {
  const execute = async (statement: Statement): Promise<unknown[]> => {
    const result = await pool.query(statement.text, statement.values);
    return result.rows as unknown[];
  };
  const runner = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    new DeferredQuery(execute, {
      text: templateText(strings, values),
      values,
    })) as unknown as SqlRunner;
  runner.query = async (text: string, params?: unknown[]) => {
    const result = await pool.query(text, params ?? []);
    return result.rows as unknown[];
  };
  runner.transaction = async (queries: any[]) => {
    const statements: Statement[] = [];
    for (const query of queries) {
      if (!isDeferred(query)) {
        throw new Error(
          "postgresSqlRunner.transaction expects statements from this runner's tagged template " +
            "(the batched statements must not have executed yet)",
        );
      }
      statements.push(query.statements[0]!);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: unknown[][] = [];
      for (const statement of statements) {
        const result = await client.query(statement.text, statement.values);
        results.push(result.rows as unknown[]);
      }
      await client.query("COMMIT");
      return results;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  return runner;
}

/**
 * One pool per connection string, created on first use.
 *
 * A pool per request would open a connection per request and exhaust the
 * server's connection slots (the reason the hosted transport could be
 * connectionless and this one cannot). The API process builds its store once
 * per request through the wiring, so memoizing here is what makes that safe;
 * {@link disposePostgresPools} releases them for a test or a shutdown.
 */
const pools = new Map<string, Pool>();

/** The process-wide pool for a connection string, created on first use. */
export function postgresPool(connectionString: string): Pool {
  const existing = pools.get(connectionString);
  if (existing !== undefined) return existing;
  const created = new Pool({ connectionString, max: 10 });
  // A pooled connection dropped by the server (restart, idle timeout) emits on
  // the pool; without a listener node-postgres turns it into an unhandled
  // 'error' event and the process dies. Log-free on purpose: the adapter's
  // caller owns observability, and this module has no logger.
  created.on("error", () => {});
  pools.set(connectionString, created);
  return created;
}

/** Release every memoized pool (tests, graceful shutdown). */
export async function disposePostgresPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((pool) => pool.end().catch(() => {})));
}

/**
 * The composition-root helper: build a `RagStore` for a Postgres connection
 * URL over the memoized pool. This is what keeps `pg` out of `apps/api` and
 * the CLIs — they name the URL and receive the seam, never a driver (ADR-0008).
 */
export function resolvePostgresStore(
  connectionString: string,
  opts: PostgresRagStoreOptions = {},
): RagStore {
  return createPostgresRagStore(postgresSqlRunner(postgresPool(connectionString)), opts);
}
