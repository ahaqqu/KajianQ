# Monorepo with engine packages and product app

KajianQ (Islamic knowledge chatbot) and DARS (generic RAG engine) live in one monorepo using workspaces: DARS as domain-agnostic packages under `packages/`, KajianQ as the product under `apps/`. Chosen over (a) building KajianQ alone and generalizing later, and (b) building DARS as a standalone platform first — reusability is a stated goal, but no second use case exists yet, so package boundaries enforce genericity without paying platform costs upfront. Split into separate repos only when a second real use case appears.
