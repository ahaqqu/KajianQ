/**
 * The admin browser's e2e credential fixture.
 *
 * One value, imported by the Playwright config (which enables the surface on the embedded
 * host) and by the steps (which type it into the form), so the two cannot drift apart. No
 * deployment uses it and it is not a secret: it exists only for the local run — which is
 * why the feature carrying it is tagged `@local` and filtered out of an external
 * `E2E_BASE_URL` run.
 */
export const E2E_ADMIN_PASSWORD = "bdd-admin-password";
