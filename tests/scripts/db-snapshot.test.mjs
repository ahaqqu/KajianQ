import { describe, expect, it } from "vitest";
import { isCorpusTable } from "../../packages/infra/scripts/pg-conn.mjs";
import {
  SNAPSHOT_ROOT,
  createSnapshotStore,
  dumpKey,
  manifestKey,
  snapshotPrefix,
} from "../../packages/infra/scripts/snapshot-store.mjs";

/**
 * Corpus-snapshot store wiring (ADR-0038).
 *
 * The property under test is the one that makes the guardrail real: a snapshot
 * must never degrade to a silent no-op. `archiveRawSources` may skip archiving
 * with a warning because the ingest continues regardless, but a backup that
 * writes nothing while reporting success is worse than no backup at all — the
 * operator would believe the corpus was protected when it was not.
 */

const FULL_ENV = {
  R2_ACCOUNT_ID: "0".repeat(32),
  R2_ACCESS_KEY_ID: "a".repeat(32),
  R2_SECRET_ACCESS_KEY: "b".repeat(64),
};

describe("snapshot key layout", () => {
  it("namespaces every snapshot under the root, one directory per label", () => {
    expect(SNAPSHOT_ROOT).toBe("snapshots");
    expect(snapshotPrefix("pre-ingest-20260912t121320z")).toBe(
      "snapshots/pre-ingest-20260912t121320z",
    );
    expect(dumpKey("pre-ingest-20260912t121320z")).toBe(
      "snapshots/pre-ingest-20260912t121320z/kajianq-pre-ingest-20260912t121320z.dump",
    );
    expect(manifestKey("pre-ingest-20260912t121320z")).toBe(
      "snapshots/pre-ingest-20260912t121320z/manifest.json",
    );
  });
});

describe("createSnapshotStore", () => {
  it("throws, naming every missing credential, instead of returning a no-op store", () => {
    expect(() => createSnapshotStore({})).toThrow(
      /R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/s,
    );
  });

  it("names exactly the variable that is absent", () => {
    let message = "";
    try {
      createSnapshotStore({ ...FULL_ENV, R2_SECRET_ACCESS_KEY: "" });
    } catch (err) {
      message = err.message;
    }
    expect(message).toContain("R2_SECRET_ACCESS_KEY");
    expect(message).not.toContain("R2_ACCOUNT_ID");
  });

  it("treats an empty string as absent, not as a configured credential", () => {
    expect(() => createSnapshotStore({ ...FULL_ENV, R2_ACCESS_KEY_ID: "" })).toThrow();
  });

  it("builds an ObjectStore over the staging bucket, defaulting its name", () => {
    const { bucket, store } = createSnapshotStore(FULL_ENV);
    expect(bucket).toBe("kajianq-raw-staging");
    for (const method of ["put", "get", "delete", "list"]) {
      expect(typeof store[method]).toBe("function");
    }
  });

  it("honours an explicit bucket override", () => {
    expect(createSnapshotStore({ ...FULL_ENV, R2_BUCKET_STAGING: "other" }).bucket).toBe("other");
  });
});

describe("corpus vs ledger classification", () => {
  it("treats the corpus and its schema identity as strict", () => {
    for (const table of ["doc_parents", "doc_children", "aligned_pairs", "schema_migrations"]) {
      expect(isCorpusTable(table), table).toBe(true);
    }
  });

  it("treats append-only ledger tables as non-strict, so smoke traffic never looks like corruption", () => {
    for (const table of [
      "eval_runs",
      "eval_results",
      "answer_traces",
      "chat_messages",
      "chat_sessions",
      "users",
      "sessions",
      "model_configs",
    ]) {
      expect(isCorpusTable(table), table).toBe(false);
    }
  });
});
