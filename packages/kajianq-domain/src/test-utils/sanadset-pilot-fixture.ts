/**
 * Shared fixtures for the pilot's tests: a small prepared slice, a corpus child
 * seeded the way the v1 corpus holds one, and a plan built the way a run builds it
 * (the target set read through the seam). The memory and Postgres suites assert the
 * same rows and the same plan, so a divergence between the doubles is a test failure
 * rather than a production surprise.
 */
import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import { readCollectionChildren } from "../sanadset-ingest-io";
import {
  buildSanadsetPlan,
  PILOT_SCOPE,
  type IngestPlan,
  type PilotScope,
} from "../sanadset-ingest-plan";
import { createPrepareAccumulator, SLICE_BOOKS, type SanadsetSourceRow } from "../sanadset-prepare";

export const BUKHARI = SLICE_BOOKS[0];

export const MATN_A =
  "إنما الأعمال بالنيات وإنما لكل امرئ ما نوى فمن كانت هجرته إلى الله ورسوله فهجرته إلى الله ورسوله";
export const MATN_B = "من حسن إسلام المرء تركه ما لا يعنيه";
export const MATN_C = "لا يؤمن أحدكم حتى يحب لأخيه ما يحب لنفسه";

/** The gate a disposable-database test uses: allowed, and honest about having no label. */
export const ESCAPE_GATE = {
  allowed: true as const,
  mode: "test-escape" as const,
  label: null,
  reasons: ["explicit test escape: disposable database, no snapshot"],
};

export function chainLiteral(names: readonly string[]): string {
  return `[${names.map((name) => `'${name}'`).join(", ")}]`;
}

export function sourceRow(overrides: Partial<SanadsetSourceRow> = {}): SanadsetSourceRow {
  return {
    rowIndex: 0,
    book: BUKHARI,
    hadithNumber: "1",
    hadith: "<SANAD>x</SANAD> <MATN>y</MATN>",
    matn: MATN_A,
    sanad: `['مالك بن أنس', 'نافع']`,
    sanadLength: 2,
    ...overrides,
  };
}

export function prepareRows(rows: readonly SanadsetSourceRow[]) {
  const accumulator = createPrepareAccumulator();
  for (const row of rows) accumulator.push(row);
  return accumulator.finish();
}

/** Seed one stored corpus child, the shape the reconciliation reads. */
export async function seedCorpusChild(
  store: RagStore,
  textRaw: string,
  options: { readonly collection?: string; readonly ordinal?: number } = {},
): Promise<string> {
  const collection = options.collection ?? PILOT_SCOPE.collection;
  const ordinal = options.ordinal ?? 0;
  const sourceKey = `hadith/${collection}/probe/${ordinal}`;
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey,
      title: `probe ${collection} ${ordinal}`,
      metadata: { sourceType: "hadith", collection },
    }),
  );
  const ids = await Effect.runPromise(
    store.insertDocChildren([
      {
        parentId,
        textRaw,
        textAr: textRaw,
        textId: null,
        citation: { sourceType: "hadith", collection, hadithNo: String(ordinal) },
        embeddingPrimary: null,
        embeddingFallback: null,
        ordinal,
        metadata: { sourceType: "hadith", collection, hadithNo: String(ordinal) },
      },
    ]),
  );
  return ids[0] as string;
}

/** Build the plan for a slice, reading the target set as a run does. */
export async function planFrom(
  store: RagStore,
  rows: readonly SanadsetSourceRow[],
  options: { readonly scope?: PilotScope; readonly limit?: number } = {},
): Promise<{ slice: ReturnType<typeof prepareRows>; plan: IngestPlan }> {
  const scope = options.scope ?? PILOT_SCOPE;
  const slice = prepareRows(rows);
  const children = await readCollectionChildren({
    store,
    collection: scope.collection,
    limit: options.limit ?? 100,
  });
  const plan = await buildSanadsetPlan({
    scope,
    rows: slice.prepared,
    sourceQuarantined: slice.quarantined,
    stats: slice.stats,
    children: children.children,
    childrenCapHit: children.capHit,
  });
  return { slice, plan };
}
