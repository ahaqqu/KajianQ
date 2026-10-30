/**
 * The S2 pilot's public surface: the plan, the write path, the snapshot gate and the
 * run that composes them.
 *
 * Unlike the S1 study's barrel this one reaches `@app/infra` — the pilot writes
 * through the `RagStore` seam — so it is a separate entry point
 * (`@app/kajianq-domain/sanadset-ingest`) and the study's no-store walk still holds.
 */

export * from "./sanadset-ingest-parts";
export * from "./sanadset-ingest-run";
