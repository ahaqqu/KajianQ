import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RagStore } from "@app/infra";
import { hashFile } from "./sanadset-csv";
import { PILOT_SCOPE } from "./sanadset-ingest-plan";
import { assertPilotReportPath } from "./sanadset-ingest-report-write";
import { runSanadsetIngest } from "./sanadset-ingest-run";
import { executeIngestPlan } from "./sanadset-ingest-write";
import { IngestGateRefusal, assertIngestGate } from "./sanadset-snapshot-gate";
import {
  BUKHARI,
  ESCAPE_GATE,
  MATN_A,
  MATN_B,
  MATN_C,
  chainLiteral,
  planFrom,
  seedCorpusChild,
  sourceRow,
} from "./test-utils/sanadset-pilot-fixture";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";

const TMP = mkdtempSync(join(tmpdir(), "sanadset-pilot-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * Test intent, named before the assertions:
 * - trap: a refused gate must write nothing — not "write and then report the
 *   refusal". The store is asserted empty after the refusal, and the orchestrator is
 *   asserted to refuse before the archive is opened (a missing CSV must surface a gate
 *   refusal, never ENOENT);
 * - trap: a dry run must write nothing while still producing the plan's counts. The
 *   report is asserted to exist and the store to hold only the seeded corpus;
 * - trap: a rerun must not duplicate a narrator, a child or a chain, and a *new* run id
 *   must not either — the run's second pass asserts exact counts, not "no error";
 * - trap: the same name written under two identity keys must stay two narrators, and a
 *   later variant must extend one of them, not create a third.
 */

describe("the pilot write path", () => {
  it("refuses a refused gate before writing and before opening the archive", async () => {
    const store = createMemoryRagStore();
    const refused = {
      allowed: false,
      mode: "verified-snapshot" as const,
      label: "pre-ingest-20261030",
      reasons: ["dump hash mismatch"],
    };
    expect(() => assertIngestGate(refused)).toThrow(IngestGateRefusal);
    const { plan } = await planFrom(store, [sourceRow()]);
    await expect(executeIngestPlan({ store, plan, gate: refused })).rejects.toThrow(
      IngestGateRefusal,
    );
    expect(store.allNarrators()).toHaveLength(0);
    expect(store.allChains()).toHaveLength(0);
    await expect(
      runSanadsetIngest({
        csvPath: join(TMP, "does-not-exist.csv"),
        expectedSha256: "0".repeat(64),
        scope: PILOT_SCOPE,
        store,
        gate: refused,
        dryRun: false,
        command: "test",
        homeDir: TMP,
        reportPath: join(TMP, "report.json"),
      }),
    ).rejects.toThrow(/refusing to write/);
  });

  it("writes narrators, book-scoped children and grade-less chains", async () => {
    const store = createMemoryRagStore();
    const storedChild = await seedCorpusChild(store, MATN_A);
    const { plan } = await planFrom(store, [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B, sanadLength: 2 }),
    ]);
    expect(plan.chains).toHaveLength(2);
    const outcome = await executeIngestPlan({
      store,
      plan,
      gate: {
        allowed: true,
        mode: "test-escape",
        label: null,
        reasons: ["test escape"],
      },
    });
    expect(outcome).toEqual({
      parentId: expect.any(String),
      childrenCreated: 1,
      chainsWritten: 2,
      narratorsWritten: plan.narrators.narrators.length,
    });

    const chains = store.allChains();
    expect(chains).toHaveLength(2);
    for (const chain of chains) {
      expect(chain.collection).toBe("bukhari");
      expect(chain.grade).toBeNull();
      expect(chain.grader).toBeNull();
      expect(chain.sourceRef).toMatch(/^sanadset:row:\d+$/);
      expect(chain.narratorIds.length).toBeGreaterThan(0);
    }
    // The exact-matn group landed on the stored child; the other created a new one.
    expect(chains.find((chain) => chain.sourceRef === "sanadset:row:0")?.childId).toBe(storedChild);

    const created = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey("sanadset/bukhari", { limit: 10 }),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.textRaw).toBe(MATN_B);
    expect(created[0]?.embeddingPrimary).toBeNull();
    expect(created[0]?.metadata).toMatchObject({
      sourceType: "hadith",
      collection: "bukhari",
      ingestSource: "sanadset",
    });
    expect(chains.find((chain) => chain.sourceRef === "sanadset:row:1")?.childId).toBe(
      created[0]?.id,
    );
  });

  it("does not write a chain for a quarantined row", async () => {
    const store = createMemoryRagStore();
    const { plan } = await planFrom(store, [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", sanadLength: 40 }),
    ]);
    await executeIngestPlan({
      store,
      plan,
      gate: { allowed: true, mode: "test-escape", label: null, reasons: [] },
    });
    expect(store.allChains().map((chain) => chain.sourceRef)).toEqual(["sanadset:row:0"]);
    expect(plan.quarantine.byRule).toEqual({ implausible_chain_length: 1 });
  });

  it("converges on a rerun and on a new run id: no duplicate narrator, child or chain", async () => {
    const store = createMemoryRagStore();
    await seedCorpusChild(store, MATN_A);
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_C, sanadLength: 2 }),
    ];
    const gate = { allowed: true, mode: "test-escape" as const, label: null, reasons: [] };

    const first = await planFrom(store, rows);
    const firstOutcome = await executeIngestPlan({ store, plan: first.plan, gate });
    const narratorsAfterFirst = store.allNarrators().length;
    const chainsAfterFirst = store.allChains().length;
    const childrenAfterFirst = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey("sanadset/bukhari", { limit: 10 }),
    );

    // The rerun reads the corpus as the next run would: the pilot's own children are
    // excluded from the target set, so the plan is identical to the first plan.
    const second = await planFrom(store, rows);
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
    const secondOutcome = await executeIngestPlan({ store, plan: second.plan, gate });
    expect(secondOutcome.childrenCreated).toBe(firstOutcome.childrenCreated);
    expect(secondOutcome.chainsWritten).toBe(firstOutcome.chainsWritten);
    expect(store.allNarrators()).toHaveLength(narratorsAfterFirst);
    expect(store.allChains()).toHaveLength(chainsAfterFirst);
    const childrenAfterSecond = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey("sanadset/bukhari", { limit: 10 }),
    );
    expect(childrenAfterSecond.map((child) => child.id)).toEqual(
      childrenAfterFirst.map((child) => child.id),
    );
  });

  it("keeps two narrators that share a name apart and extends one with a variant", async () => {
    const store = createMemoryRagStore();
    const one = await Effect.runPromise(
      store.upsertNarrator({
        identityKey: "identity:one",
        canonicalNameAr: "عبد الله بن محمد",
        nameVariants: ["عبدالله بن محمد"],
      }),
    );
    const two = await Effect.runPromise(
      store.upsertNarrator({
        identityKey: "identity:two",
        canonicalNameAr: "عبد الله بن محمد",
      }),
    );
    expect(one.id).not.toBe(two.id);
    expect(store.allNarrators()).toHaveLength(2);

    const extended = await Effect.runPromise(
      store.upsertNarrator({
        identityKey: "identity:one",
        canonicalNameAr: "عبد الله بن محمد",
        nameVariants: ["عبد الله بن محمد بن سعد"],
      }),
    );
    expect(extended.id).toBe(one.id);
    expect(extended.nameVariants).toEqual(["عبدالله بن محمد", "عبد الله بن محمد بن سعد"]);
    expect(store.allNarrators()).toHaveLength(2);
  });

  it("runs a dry run end to end without writing to the store", async () => {
    const csvPath = join(TMP, "sanadset.csv");
    writeFileSync(
      csvPath,
      [
        "Hadith,Book,Num_hadith,Matn,Sanad,Sanad_Length",
        `x,${BUKHARI},1,${MATN_A},"${chainLiteral(["مالك بن أنس", "نافع"])}",2`,
      ].join("\n") + "\n",
      "utf8",
    );
    const { sha256 } = await hashFile(csvPath);
    const store = createMemoryRagStore();
    const run = await runSanadsetIngest({
      csvPath,
      expectedSha256: sha256,
      scope: PILOT_SCOPE,
      store,
      gate: { allowed: true, mode: "dry-run", label: null, reasons: ["dry run"] },
      dryRun: true,
      command: "test",
      homeDir: TMP,
      reportPath: join(TMP, "dry-run-report.json"),
    });
    expect(run.dryRun).toBe(true);
    expect(run.outcome).toBeNull();
    expect(store.allNarrators()).toHaveLength(0);
    expect(store.allChains()).toHaveLength(0);
    expect(run.document.pilot.schemaVersion).toBe(1);
    expect(run.document.pilot.dryRun).toBe(true);
    expect(run.document.pilot.chains.planned).toBe(1);
    expect(run.document.pilot.chains.written).toBe(0);
    expect(run.document.pilot.matn.createdChildren).toBe(0);
    expect(run.document.pilot.cost).toEqual({ modelCalls: 0, costMicroUsd: 0 });
    expect(existsSync(join(TMP, "dry-run-report.json"))).toBe(true);
    expect(readFileSync(join(TMP, "dry-run-report.md"), "utf8")).toContain("Dry run");
  });

  it("runs the command twice under two run ids without duplicating a row", async () => {
    const csvPath = join(TMP, "sanadset-rerun.csv");
    writeFileSync(
      csvPath,
      [
        "Hadith,Book,Num_hadith,Matn,Sanad,Sanad_Length",
        `x,${BUKHARI},1,${MATN_A},"${chainLiteral(["مالك بن أنس", "نافع"])}",2`,
        `y,${BUKHARI},2,${MATN_B},"${chainLiteral(["سالم", "عبد الله بن عمر"])}",2`,
      ].join("\n") + "\n",
      "utf8",
    );
    const { sha256 } = await hashFile(csvPath);
    const store = createMemoryRagStore();
    const gate = { allowed: true, mode: "test-escape" as const, label: null, reasons: [] };
    const runOnce = (runId: string) =>
      runSanadsetIngest({
        csvPath,
        expectedSha256: sha256,
        scope: PILOT_SCOPE,
        store,
        gate,
        dryRun: false,
        command: `test ${runId}`,
        homeDir: TMP,
        reportPath: join(TMP, `${runId}.json`),
        runId,
      });

    const first = await runOnce("s2-bukhari-run-one");
    const narratorRows = store.allNarrators().length;
    const chainRows = store.allChains().length;
    expect(first.outcome?.childrenCreated).toBe(2);
    expect(chainRows).toBe(2);
    expect(narratorRows).toBe(4);

    const second = await runOnce("s2-bukhari-run-two");
    expect(second.runId).toBe("s2-bukhari-run-two");
    expect(second.plan.chains).toHaveLength(2);
    expect(second.outcome?.chainsWritten).toBe(2);
    expect(store.allNarrators()).toHaveLength(narratorRows);
    expect(store.allChains()).toHaveLength(chainRows);
    const children = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey("sanadset/bukhari", { limit: 10 }),
    );
    expect(children).toHaveLength(2);
    // The second run's report exists under its own id and carries the same counts.
    expect(existsSync(join(TMP, "s2-bukhari-run-two.json"))).toBe(true);
    const document = JSON.parse(readFileSync(join(TMP, "s2-bukhari-run-two.json"), "utf8")) as {
      report: { childrenWritten: number; runId: string };
    };
    expect(document.report.runId).toBe("s2-bukhari-run-two");
    expect(document.report.childrenWritten).toBe(2);
  });

  it("refuses a report path inside a checkout before the run starts", () => {
    expect(() => assertPilotReportPath("report.json")).toThrow(/repository/);
    expect(() => assertPilotReportPath(join(TMP, "report.json"))).not.toThrow();
  });
});
