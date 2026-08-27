import type { Env, Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

/** Hono's secure-headers option shape (not exported upstream — derived). */
type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

/** CSP directives every forked project ships by default. */
export const DEFAULT_CSP: NonNullable<
  SecureHeadersOptions["contentSecurityPolicy"]
> = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // Documented trade-off: Vite injects styles at build time; tightening to
  // hashes/nonces is a per-project decision. script-src stays 'self'.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:"],
  fontSrc: ["'self'", "data:"],
  // Sentry is template-shipped; its ingest endpoint is the only cross-origin call.
  connectSrc: ["'self'", "https://sentry.io"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  // Directives with no default-src fallback must be explicit (ZAP 10055):
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/**
 * Deny-by-default Permissions-Policy (ZAP 10063). Apps that need device
 * APIs override it per project.
 */
export const DEFAULT_PERMISSIONS_POLICY: NonNullable<
  SecureHeadersOptions["permissionsPolicy"]
> = {
  camera: [],
  microphone: [],
  geolocation: [],
};

export type HardeningOptions = {
  /** Merged over {@link DEFAULT_CSP} (shallow) — set a directive to override its default. */
  contentSecurityPolicy?: SecureHeadersOptions["contentSecurityPolicy"];
  /** Replaces {@link DEFAULT_PERMISSIONS_POLICY} when provided. */
  permissionsPolicy?: SecureHeadersOptions["permissionsPolicy"];
  /**
   * Opt in to `Cross-Origin-Embedder-Policy: require-corp`. Default off:
   * the app has no cross-origin-isolation requirement; COOP/CORP still ship.
   */
  crossOriginEmbedderPolicy?: boolean;
};

/**
 * Installs the shared security-header policy on the app: CSP, COOP/CORP,
 * HSTS, nosniff, X-Frame-Options, and Permissions-Policy (via Hono's
 * `secureHeaders`). One policy, owned by this package, so forked projects
 * inherit header hardening via template-sync instead of copying middleware.
 */
export function installSecurityHeaders<E extends Env>(
  api: Hono<E>,
  opts: HardeningOptions = {},
): void {
  api.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { ...DEFAULT_CSP, ...opts.contentSecurityPolicy },
      permissionsPolicy: opts.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY,
      ...(opts.crossOriginEmbedderPolicy
        ? { crossOriginEmbedderPolicy: "require-corp" }
        : {}),
    }),
  );
}