/** Minimal OpenAPI 3.1 document for Schemathesis / docs. */
export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Agentic Template API", version: "1.0.0" },
    paths: {
      "/v1/health": {
        get: {
          summary: "Health",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/auth/anonymous": {
        post: {
          summary: "Create anonymous session",
          responses: { "200": { description: "Session" } },
        },
      },
      "/v1/auth/me": {
        delete: {
          summary: "Delete account and cascade data",
          responses: {
            "204": { description: "Deleted" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/v1/notes": {
        get: {
          summary: "List notes",
          responses: {
            "200": { description: "OK" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/v1/sync": {
        post: {
          summary: "Sync notes",
          responses: {
            "200": { description: "Merged" },
            "401": { description: "Unauthorized" },
            "409": { description: "Schema mismatch" },
          },
        },
      },
    },
  };
}
