/**
 * The two reads the pilot performs before it plans anything: the archive bytes and
 * one collection's stored children.
 *
 * The archive is verified against the pinned digest first — a different file is a
 * different study, and every count in the report would silently describe another
 * corpus. The child read is bounded and fails closed on the bound: the read cannot
 * tell "exactly the limit" from "more than the limit", and a truncated target set
 * could make a group look unmatched and create a duplicate child, so the plan (not
 * this module) refuses when the bound was hit.
 *
 * Children this pilot created are excluded from the target set. They are the
 * residue of an earlier run, and re-matching a group to its own child would hide a
 * newly available stored target; excluding them also keeps a re-run's plan
 * identical to its first plan.
 */

import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import { hashFile } from "./sanadset-csv";
import type { ExistingChildRow } from "./sanadset-ingest-match";
import { streamSlice } from "./sanadset-stream";

/** Metadata key the pilot stamps on the rows it creates, so a rerun can ignore them. */
export const PILOT_INGEST_SOURCE_KEY = "ingestSource";
export const PILOT_INGEST_SOURCE = "sanadset";

type SliceStream = Awaited<ReturnType<typeof streamSlice>>;

export type SliceRead = Pick<SliceStream, "prepared" | "quarantined" | "stats"> & {
  readonly source: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly recordsRead: number;
};

/** Read the archive from its bytes: hash first, then the one streaming pass. */
export async function readSanadsetSlice(input: {
  readonly csvPath: string;
  readonly expectedSha256: string;
}): Promise<SliceRead> {
  const hashed = await hashFile(input.csvPath);
  if (hashed.sha256 !== input.expectedSha256) {
    throw new Error(
      `sanadset source sha256 ${hashed.sha256} does not match the pinned ${input.expectedSha256} ` +
        "(a different archive is a different ingest; pass --sha256 only when that is intended)",
    );
  }
  const slice = await streamSlice(input.csvPath);
  return {
    source: {
      fileName: input.csvPath.split("/").pop() ?? input.csvPath,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
    },
    recordsRead: slice.recordsRead,
    prepared: slice.prepared,
    quarantined: slice.quarantined,
    stats: slice.stats,
  };
}

export type ChildrenRead = {
  readonly children: readonly ExistingChildRow[];
  /** Rows the store returned, before the pilot's own children were excluded. */
  readonly read: number;
  readonly capHit: boolean;
};

/** Read one collection's stored hadith children, excluding the pilot's own rows. */
export async function readCollectionChildren(input: {
  readonly store: RagStore;
  readonly collection: string;
  readonly limit: number;
}): Promise<ChildrenRead> {
  if (input.limit <= 0) throw new Error("the child read limit must be positive");
  const rows = await Effect.runPromise(
    input.store.findDocChildrenByMetadata(
      { sourceType: "hadith", collection: input.collection },
      { limit: input.limit },
    ),
  );
  const children: ExistingChildRow[] = [];
  for (const row of rows) {
    if (row.metadata[PILOT_INGEST_SOURCE_KEY] === PILOT_INGEST_SOURCE) continue;
    const stored = row.metadata["collection"];
    children.push({
      id: row.id,
      textRaw: row.textRaw,
      collection: typeof stored === "string" ? stored : input.collection,
    });
  }
  return { children, read: rows.length, capHit: rows.length >= input.limit };
}
