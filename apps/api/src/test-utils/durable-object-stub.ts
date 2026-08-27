/**
 * Minimal `DurableObject` base class for the Node (vitest) test environment,
 * where the `cloudflare:workers` runtime module does not exist. Vitest aliases
 * `cloudflare:workers` to this file (see `vitest.config.ts`). The real class is
 * provided by the Workers runtime; tests that import the entrypoint never
 * instantiate the Durable Object, so only the class shape matters here.
 */
export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
