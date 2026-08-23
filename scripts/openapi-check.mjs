#!/usr/bin/env bun
import { createApi } from "../apps/api/src/app";

/**
 * openapi-check.mjs
 *
 * Fast agent-runnable check that the generated OpenAPI document stays in sync
 * with the registered Hono routes. The route coverage test in
 * apps/api/src/app.test.ts is the real gate; this script gives a quick local
 * command and a non-zero exit code when the doc is broken or drifting.
 */

const env = { ASSETS: { fetch } };

async function main() {
  const api = createApi();
  const res = await api.request("/openapi.json", {}, env);
  if (!res.ok) {
    console.error(`openapi:check failed: /openapi.json returned ${res.status}`);
    process.exit(1);
  }

  const doc = await res.json();
  if (doc.openapi !== "3.1.0") {
    console.error(
      `openapi:check failed: expected openapi 3.1.0, got ${doc.openapi}`,
    );
    process.exit(1);
  }

  const registered = [
    ...new Set(
      api.routes
        .filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();

  const documented = Object.entries(doc.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    )
    .sort();

  const registeredJson = JSON.stringify(registered);
  const documentedJson = JSON.stringify(documented);

  if (registeredJson !== documentedJson) {
    console.error("openapi:check failed: documented routes do not match registered routes");
    console.error("Registered:");
    console.error(registeredJson);
    console.error("Documented:");
    console.error(documentedJson);
    process.exit(1);
  }

  console.log(
    `openapi:check OK (${registered.length} /v1 routes, OpenAPI ${doc.openapi})`,
  );
}

main().catch((err) => {
  console.error("openapi:check failed:", err);
  process.exit(1);
});
