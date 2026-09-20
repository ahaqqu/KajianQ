import { describe, expect, it } from "vitest";
import {
  carriesPersonalData,
  isCorpusTable,
  isPersonalDataTable,
} from "../../packages/infra/scripts/pg-conn.mjs";
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

describe("personal-data classification (ADR-0043 decision 5)", () => {
  it("names exactly the tables that make an archive personal-data-bearing", () => {
    for (const table of [
      "users",
      "sessions",
      "chat_sessions",
      "chat_messages",
      "answer_traces",
      "eval_runs",
      "eval_results",
    ]) {
      expect(isPersonalDataTable(table), table).toBe(true);
    }
    // Corpus tables are the paid asset, not personal data; treating them as
    // such would make the encryption gate fire on every corpus snapshot.
    for (const table of ["doc_parents", "doc_children", "aligned_pairs", "schema_migrations"]) {
      expect(isPersonalDataTable(table), table).toBe(false);
    }
  });

  it("flags an archive as personal-data-bearing when any such table holds a row", () => {
    expect(carriesPersonalData({ doc_children: 999, users: 1 })).toBe(true);
    expect(carriesPersonalData({ doc_children: 999, chat_messages: 4 })).toBe(true);
  });

  it("does not flag a schema-only snapshot of an empty database", () => {
    // The one case where an unencrypted archive is honest — and treating it as
    // personal data would forbid that case.
    expect(carriesPersonalData({ doc_children: 0, users: 0, sessions: 0 })).toBe(false);
    expect(carriesPersonalData({ doc_parents: 12, doc_children: 400 })).toBe(false);
  });
});
