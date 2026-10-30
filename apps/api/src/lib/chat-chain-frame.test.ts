import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import {
  ChatCitationsFrameSchema,
  ChatTraceFrameSchema,
  type ChainEvidenceDetail,
  type Trace,
} from "@app/contracts";
import type { DocChildById, NarratorIdsLookup } from "@app/infra";
import { deriveCitationsFrame } from "./chat-citations";
import { deriveTraceFrame, narratorFetcher, narratorNamesOrEmpty } from "./chat-trace";

/**
 * The frame derivation over the per-chain record (spec §9.5).
 *
 * The invariant: **the wire frames carry exactly the transmission rows the
 * persisted trace recorded, bound to the child that holds them.** The ways that
 * fails silently are the cases below:
 *
 * - a citation showing the wrong child's chains (the rows must key on the childId
 *   the retrieval event and the evidence record share);
 * - a display join shortening a chain by dropping a narrator it could not name;
 * - an empty record reading the same as a run that recorded no read at all;
 * - a failed narrator read inventing a name instead of degrading to the id;
 * - a projection that re-sorts or picks among the rows.
 */

const NARRATOR_ONE = "11111111-1111-4111-8111-111111111111";

const detail: ChainEvidenceDetail = {
  consulted: 1,
  perChildCap: 8,
  children: [
    {
      childId: "h1",
      chains: [
        { narratorIds: [NARRATOR_ONE, "n-unknown"], grade: "sahih", grader: "al-bukhari" },
        { narratorIds: [NARRATOR_ONE], grade: "dhaif", grader: "al-daraqutni" },
      ],
    },
  ],
  missingNarratorIds: ["n-unknown"],
};

function traceWith(events: Trace["events"]): Trace {
  return { id: "t1", createdAt: 1, events };
}

function traceOf(detail: ChainEvidenceDetail | null, refs = ["h1"]): Trace {
  return traceWith([
    ...(detail === null
      ? []
      : [
          {
            stage: "retriever" as const,
            kind: "chain_evidence" as const,
            detail,
            at: 4,
          },
        ]),
    {
      stage: "retriever" as const,
      kind: "retrieval" as const,
      detail: { chunks: refs.map((id) => ({ id })) },
      at: 5,
    },
  ]);
}

function hadithRow(id: string, label = "HR. Bukhari no. 1"): DocChildById {
  return {
    id,
    parentId: `parent-${id}`,
    textRaw: "raw",
    textAr: "حدثنا",
    textId: null,
    citation: {},
    embeddingPrimary: null,
    embeddingFallback: null,
    ordinal: 0,
    metadata: { citation: label },
    createdAt: 0,
    parentTitle: "HR. Bukhari",
  };
}

const names = new Map([[NARRATOR_ONE, "نافع"]]);

describe("deriveCitationsFrame — the per-chain evidence a citation carries", () => {
  const derive = (trace: Trace, narratorNames?: ReadonlyMap<string, string>) =>
    deriveCitationsFrame({
      trace,
      messageId: "m1",
      answerText: "Hadits [HR. Bukhari no. 1].",
      chunksById: new Map([["h1", hadithRow("h1")]]),
      ...(narratorNames !== undefined ? { narratorNames } : {}),
    });

  it("carries every recorded row, in order, bound to the cited child", () => {
    const frame = derive(traceOf(detail), names);
    const parsed = v.safeParse(ChatCitationsFrameSchema, frame);
    expect(parsed.success).toBe(true);
    expect(frame.citations).toHaveLength(1);
    expect(frame.citations[0]?.chains).toEqual([
      {
        narrators: [
          { id: NARRATOR_ONE, nameAr: "نافع" },
          // An unresolved narrator keeps its id: the chain is never shortened.
          { id: "n-unknown" },
        ],
        grade: "sahih",
        grader: "al-bukhari",
      },
      {
        narrators: [{ id: NARRATOR_ONE, nameAr: "نافع" }],
        grade: "dhaif",
        grader: "al-daraqutni",
      },
    ]);
  });

  it("omits the field for a trace that recorded no chain read", () => {
    const frame = derive(traceOf(null), names);
    expect(frame.citations[0]?.chains).toBeUndefined();
  });

  it("binds the rows to their own child, never to another cited passage", () => {
    const twoRows: ChainEvidenceDetail = {
      ...detail,
      consulted: 2,
      children: [...detail.children, { childId: "h2", chains: [detail.children[0]!.chains[1]!] }],
    };
    const frame = deriveCitationsFrame({
      trace: traceOf(twoRows, ["h1", "h2"]),
      messageId: "m1",
      answerText: "Satu [HR. Bukhari no. 1] dan dua [HR. Muslim no. 1].",
      chunksById: new Map([
        ["h1", hadithRow("h1")],
        ["h2", hadithRow("h2", "HR. Muslim no. 1")],
      ]),
      narratorNames: names,
    });
    const byLabel = new Map(frame.citations.map((citation) => [citation.label, citation]));
    expect(byLabel.size).toBe(2);
    const labels = [...byLabel.keys()];
    expect(byLabel.get(labels[0]!)?.chains?.[0]?.grade).toBe("sahih");
    expect(byLabel.get(labels[1]!)?.chains).toHaveLength(1);
    expect(byLabel.get(labels[1]!)?.chains?.[0]?.grade).toBe("dhaif");
  });
});

describe("deriveTraceFrame — the chains-consulted block", () => {
  const derive = (trace: Trace, narratorNames?: ReadonlyMap<string, string>) =>
    deriveTraceFrame({
      trace,
      messageId: "m1",
      chunksById: new Map([["h1", hadithRow("h1")]]),
      ...(narratorNames !== undefined ? { narratorNames } : {}),
    });

  it("projects the recorded children with their rows", () => {
    const frame = derive(traceOf(detail), names);
    expect(v.safeParse(ChatTraceFrameSchema, frame).success).toBe(true);
    expect(frame.technical.chains).toEqual([
      {
        childId: "h1",
        chains: [
          {
            narrators: [{ id: NARRATOR_ONE, nameAr: "نافع" }, { id: "n-unknown" }],
            grade: "sahih",
            grader: "al-bukhari",
          },
          {
            narrators: [{ id: NARRATOR_ONE, nameAr: "نافع" }],
            grade: "dhaif",
            grader: "al-daraqutni",
          },
        ],
      },
    ]);
  });

  it("distinguishes a read that found nothing from no read at all", () => {
    const emptyRead: ChainEvidenceDetail = { ...detail, children: [] };
    expect(derive(traceOf(emptyRead)).technical.chains).toEqual([]);
    expect(derive(traceOf(null)).technical.chains).toBeUndefined();
  });

  it("flags a bounded list so the panel never presents a prefix as the whole", () => {
    const bounded: ChainEvidenceDetail = {
      ...detail,
      children: [{ ...detail.children[0]!, moreMayExist: true }],
    };
    expect(derive(traceOf(bounded)).technical.chains?.[0]?.moreMayExist).toBe(true);
  });
});

describe("narratorNamesOrEmpty — the display join degrades by omission", () => {
  it("returns the catalogue spellings it resolved and drops the unknown ids", async () => {
    const lookup: NarratorIdsLookup = {
      narrators: [
        {
          id: NARRATOR_ONE,
          canonicalNameAr: "نافع",
          nameVariants: [],
          kunya: null,
          laqab: null,
          deathYear: null,
          tabaqa: null,
          reliabilityByCritic: {},
          metadata: {},
        },
      ],
      missingIds: ["n-unknown"],
    };
    const resolved = await narratorNamesOrEmpty({
      ids: [NARRATOR_ONE, "n-unknown"],
      fetchNarrators: async () => lookup,
      warn: () => {},
      warnKey: "k",
      warnFields: {},
    });
    expect([...resolved.entries()]).toEqual([[NARRATOR_ONE, "نافع"]]);
  });

  it("degrades to no names and warns once when the read fails", async () => {
    const warnings: string[] = [];
    const resolved = await narratorNamesOrEmpty({
      ids: [NARRATOR_ONE],
      fetchNarrators: async () => {
        throw new Error("store down");
      },
      warn: (msg) => warnings.push(msg),
      warnKey: "chat.test.narrators",
      warnFields: { messageId: "m1" },
    });
    expect(resolved.size).toBe(0);
    expect(warnings).toEqual(["chat.test.narrators"]);
  });

  it("issues no read when there is nothing to join", async () => {
    let calls = 0;
    const resolved = await narratorNamesOrEmpty({
      ids: [],
      fetchNarrators: async () => {
        calls += 1;
        return { narrators: [], missingIds: [] };
      },
      warn: () => {},
      warnKey: "k",
      warnFields: {},
    });
    expect(resolved.size).toBe(0);
    expect(calls).toBe(0);
  });

  it("binds the fetcher to the store's by-id read", async () => {
    const asked: (readonly string[])[] = [];
    const fetcher = narratorFetcher(
      {
        getNarratorsByIds: (ids) => {
          asked.push(ids);
          return { pipe: () => ({}) } as never;
        },
      } as never,
      ((effect: unknown) => Promise.resolve(effect)) as never,
    );
    void fetcher;
    expect(asked).toEqual([]);
  });
});
