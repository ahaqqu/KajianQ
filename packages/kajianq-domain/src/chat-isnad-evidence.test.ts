import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import * as v from "valibot";
import {
  chainEvidenceDetailSchema,
  type ChainEvidenceDetail,
  type TraceEvent,
} from "@app/contracts";
import type { NarratorChainRecord, NarratorIdsLookup, NarratorRecord } from "@app/infra";

import type { Chunk } from "@app/rag-core";
import type { StoreError } from "@app/infra";
import {
  DEFAULT_CHAIN_EVIDENCE_CHILD_CAP,
  citationBaseAddress,
  hasWeakChain,
  isnadEvidenceOf,
  readChainEvidence,
  renderChainCitation,
  renderChainSegments,
  renderNarratorReliability,
  type ChainEvidenceStore,
} from "./chat-isnad-evidence";
import { renderEvidenceChunk } from "./chat-assembler";
import { hasWeakGradeChunk } from "./chat-postprocess";
import { chatSystemPrompt } from "./chat-prompts";

/**
 * The per-chain evidence contract, tested where it can fail silently.
 *
 * The invariant: **what a reader is shown is the transmission the store holds** —
 * every stored row in stored order, each with its own grade and grader, and no
 * grade the store did not state. The failure this suite exists to catch is a
 * silent upgrade: a read that picks the strongest row, drops the weak one, or
 * lets a missing verdict read as sound would still render a plausible citation
 * while telling the reader something the evidence does not say.
 *
 * The trap cases are named before they are written:
 *
 * - `sahih` and `dhaif` rows for one passage → both render, stored order, and the
 *   flattened corpus grade never appears (mutation: picking the best row reddens it).
 * - a passage whose ONLY chain is dhaif → the render says dhaif, never sahih
 *   (mutation: defaulting a null/unknown grade to `sahih` reddens it).
 * - an ungraded row beside a graded one → the ungraded row says so rather than
 *   borrowing the neighbour's verdict.
 * - a row whose grade has no grader, or an unknown grade → the read REFUSES
 *   rather than presenting an unattributable verdict.
 * - a child with no row → no evidence, and the evidence block keeps the v1 shape;
 *   nothing named `sanad` is invented.
 * - a bounded read → the prefix plus `moreMayExist`, never a silent truncation.
 * - the trace record → parses against the contract's own schema.
 */

/** One seeded chain, the seam's record shape. */
function chain(overrides: Partial<NarratorChainRecord> = {}): NarratorChainRecord {
  return {
    id: "chain-1",
    childId: "h1",
    collection: "bukhari",
    narratorIds: ["n1", "n2"],
    grade: "sahih",
    grader: "al-bukhari",
    sourceRef: null,
    ...overrides,
  };
}

function narrator(overrides: Partial<NarratorRecord> = {}): NarratorRecord {
  return {
    id: "n1",
    canonicalNameAr: "نافع",
    nameVariants: [],
    kunya: null,
    laqab: null,
    deathYear: null,
    tabaqa: null,
    reliabilityByCritic: { "yahya-ibn-said": { verdict: "thiqa", sourceRef: "tahdzib-1" } },
    metadata: {},
    ...overrides,
  };
}

/** A store double over seeded rows, counting the reads it answers. */
function fakeStore(input: {
  chains: readonly NarratorChainRecord[];
  narrators: readonly NarratorRecord[];
}) {
  const reads: { childId: string; limit: number }[] = [];
  const narratorReads: (readonly string[])[] = [];
  const store: ChainEvidenceStore = {
    listChainsForChild: (childId, opts) => {
      reads.push({ childId, limit: opts.limit });
      return Effect.succeed(input.chains.filter((row) => row.childId === childId));
    },
    getNarratorsByIds: (ids) => {
      narratorReads.push(ids);
      const found = input.narrators.filter((row) => ids.includes(row.id));
      return Effect.succeed<NarratorIdsLookup>({
        narrators: found,
        missingIds: ids.filter((id) => !found.some((row) => row.id === id)),
      });
    },
  };
  return { store, reads, narratorReads };
}

function hadithChunk(id: string, metadata: Record<string, unknown> = {}): Chunk {
  return {
    id,
    text: "arabic",
    metadata: {
      sourceType: "hadith",
      citation: "HR. Bukhari no. 1 (Sahih)",
      grade: "sahih",
      ...metadata,
    },
  };
}

/** The stage edge's bridge: a store Effect run to a promise. */
const bridge = <A>(effect: Effect.Effect<A, StoreError>) => Effect.runPromise(effect);

describe("readChainEvidence — the stored transmission, never a selection", () => {
  it("renders every stored row in stored order, with the flattened grade gone", async () => {
    // Stored order is dhaif FIRST: the render must follow the record, not rank it.
    const { store } = fakeStore({
      chains: [
        chain({ id: "c-weak", grade: "dhaif", grader: "al-daraqutni" }),
        chain({ id: "c-sound" }),
      ],
      narrators: [narrator(), narrator({ id: "n2", canonicalNameAr: "ابن عمر" })],
    });
    const { chunks, detail } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge }),
    );

    const evidence = isnadEvidenceOf(chunks[0]!);
    expect(evidence).not.toBeNull();
    expect(evidence?.chains.map((row) => row.grade)).toEqual(["dhaif", "sahih"]);
    const segments = renderChainSegments(evidence!);
    expect(segments).toEqual([
      "(Dhaif — al-daraqutni; sanad: نافع < ابن عمر)",
      "(Sahih — al-bukhari; sanad: نافع < ابن عمر)",
    ]);
    // The flattened corpus grade (`HR. Bukhari no. 1 (Sahih)`) never reaches the
    // page: the evidence block carries the rows, so a reader cannot read one
    // verdict for a passage whose chains disagree.
    const rendered = renderEvidenceChunk(chunks[0]!);
    expect(rendered).not.toContain("(Sahih)]");
    expect(rendered).toContain("Dhaif — al-daraqutni");
    expect(rendered).toContain("Sahih — al-bukhari");
    expect(detail?.children[0]?.chains.map((row) => row.grade)).toEqual(["dhaif", "sahih"]);
  });

  it("keeps a passage whose only chain is weak weak — no default grade", async () => {
    const { store } = fakeStore({
      chains: [chain({ grade: "dhaif", grader: "al-daraqutni" })],
      narrators: [narrator()],
    });
    const { chunks } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge }),
    );
    const rendered = renderEvidenceChunk(chunks[0]!);
    expect(rendered).toContain("Dhaif — al-daraqutni");
    expect(rendered).not.toMatch(/Sahih/);
    // And the deterministic weak-evidence rule fires on the chain, so an answer
    // that quoted this passage is flagged even though its flat grade is sound.
    expect(hasWeakChain(isnadEvidenceOf(chunks[0]!)!)).toBe(true);
    expect(hasWeakGradeChunk(chunks)).toBe(true);
  });

  it("says an ungraded row is ungraded rather than borrowing the neighbour's grade", async () => {
    const { store } = fakeStore({
      chains: [chain({ id: "c-sound" }), chain({ id: "c-none", grade: null, grader: null })],
      narrators: [narrator(), narrator({ id: "n2", canonicalNameAr: "ابن عمر" })],
    });
    const { chunks } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge }),
    );
    expect(renderChainSegments(isnadEvidenceOf(chunks[0]!)!)).toEqual([
      "(Sahih — al-bukhari; sanad: نافع < ابن عمر)",
      "(tanpa penilaian; sanad: نافع < ابن عمر)",
    ]);
  });

  it("refuses a grade without its grader and a grade outside the vocabulary", async () => {
    for (const bad of [
      chain({ grade: "sahih", grader: null }),
      chain({ grade: "sahihh", grader: "someone" }),
      chain({ grader: "someone", grade: null }),
    ]) {
      const { store } = fakeStore({ chains: [bad], narrators: [narrator()] });
      await expect(
        Effect.runPromise(readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge })),
      ).rejects.toBeTruthy();
    }
  });

  it("carries the critic, the verdict term and the source for a reliability question", async () => {
    const { store } = fakeStore({ chains: [chain()], narrators: [narrator()] });
    const { chunks } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge }),
    );
    const evidence = isnadEvidenceOf(chunks[0]!)!;
    expect(renderNarratorReliability(evidence)).toBe("نافع — yahya-ibn-said: thiqa — tahdzib-1");
    // The assembled evidence block carries the same line, which is what makes the
    // question answerable from the narrator rows rather than the model's memory.
    expect(renderEvidenceChunk(chunks[0]!)).toContain("Narator: نافع — yahya-ibn-said: thiqa");
    // A narrator the catalogue lacks keeps its id and loses only the name.
    expect(renderChainSegments(isnadEvidenceOf(chunks[0]!)!)[0]).toContain("n2");
  });

  it("records a bounded read as a prefix: the cap plus the proof row, and moreMayExist", async () => {
    const { store, reads } = fakeStore({
      chains: [chain({ id: "c1" }), chain({ id: "c2", grade: "hasan", grader: "al-tirmidhi" })],
      narrators: [narrator()],
    });
    const { chunks, detail } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge, chainCap: 1 }),
    );
    // The read asks for one row beyond the cap so "more exist" is a fact.
    expect(reads).toEqual([{ childId: "h1", limit: 2 }]);
    expect(detail?.perChildCap).toBe(1);
    expect(detail?.children[0]?.moreMayExist).toBe(true);
    expect(detail?.children[0]?.chains).toHaveLength(1);
    expect(renderChainCitation(isnadEvidenceOf(chunks[0]!)!)).toContain(
      "sanad lain tidak ditampilkan",
    );
  });

  it("records the read even when the evidence holds no row, and reads nothing else", async () => {
    const { store, reads } = fakeStore({ chains: [], narrators: [] });
    const { chunks, detail } = await Effect.runPromise(
      readChainEvidence({ chunks: [hadithChunk("h1")], store, bridge }),
    );
    expect(reads).toHaveLength(1);
    expect(detail).toEqual({
      consulted: 1,
      perChildCap: 8,
      children: [],
      missingNarratorIds: [],
    });
    // No row means no evidence block: the v1 rendering stands and nothing named
    // `sanad` is invented.
    expect(isnadEvidenceOf(chunks[0]!)).toBeNull();
    expect(renderEvidenceChunk(chunks[0]!)).toContain("[HR. Bukhari no. 1 (Sahih)]");
    expect(renderEvidenceChunk(chunks[0]!)).not.toContain("sanad");
  });

  it("issues no store read at all when no child bears a transmission", async () => {
    const { store, reads } = fakeStore({ chains: [chain()], narrators: [narrator()] });
    const chunk: Chunk = { id: "q1", text: "verse", metadata: { sourceType: "quran" } };
    const { chunks, detail } = await Effect.runPromise(
      readChainEvidence({ chunks: [chunk], store, bridge }),
    );
    expect(reads).toEqual([]);
    expect(detail).toBeNull();
    expect(chunks).toEqual([chunk]);
  });

  it("covers at most the configured number of children, in retrieval order", async () => {
    const { store, reads } = fakeStore({
      chains: [chain({ childId: "h1" }), chain({ childId: "h2" }), chain({ childId: "h3" })],
      narrators: [narrator()],
    });
    const { detail } = await Effect.runPromise(
      readChainEvidence({
        chunks: [hadithChunk("h1"), hadithChunk("h2"), hadithChunk("h3")],
        store,
        bridge,
        childCap: 2,
      }),
    );
    expect(reads.map((read) => read.childId)).toEqual(["h1", "h2"]);
    expect(detail?.consulted).toBe(2);
    expect(DEFAULT_CHAIN_EVIDENCE_CHILD_CAP).toBeGreaterThanOrEqual(2);
  });

  it("produces a record the trace contract accepts, attribution included", async () => {
    const { store } = fakeStore({
      chains: [chain(), chain({ id: "c2", grade: null, grader: null, sourceRef: "src" })],
      narrators: [narrator()],
    });
    const { detail } = await Effect.runPromise(
      readChainEvidence({
        chunks: [hadithChunk("h1")],
        store: {
          ...store,
          getNarratorsByIds: () => Effect.succeed({ narrators: [], missingIds: ["n1", "n2"] }),
        },
        bridge,
      }),
    );
    const parsed = v.safeParse(chainEvidenceDetailSchema, detail);
    expect(parsed.success).toBe(true);
    expect((detail as ChainEvidenceDetail).missingNarratorIds).toEqual(["n1", "n2"]);
    // The record a reader sees names the rows' ids even when no name resolved.
    expect(parsed.success && parsed.output.children[0]?.chains[1]?.sourceRef).toBe("src");
  });
});

describe("the evidence block and the answer rules that read it", () => {
  it("renders a cross-collection passage pair with both addresses and both grades", async () => {
    // The takhrij case: one matn reported in two collections, one chain each. The
    // context must carry both addresses with their own grades so the answer can
    // name the collection and the supporting chain.
    const chunkA = hadithChunk("h1", { citation: "HR. Bukhari no. 1 (Sahih)" });
    const chunkB = hadithChunk("h2", { citation: "HR. Muslim no. 1 (Hasan)" });
    const { store } = fakeStore({
      chains: [
        chain({ childId: "h1" }),
        chain({ id: "c2", childId: "h2", grade: "hasan", grader: "al-tirmidhi" }),
      ],
      narrators: [narrator()],
    });
    const { chunks } = await Effect.runPromise(
      readChainEvidence({ chunks: [chunkA, chunkB], store, bridge }),
    );
    // The generator's context is this render, joined: the assembler adds history
    // and the question, never a different view of the evidence.
    const text = chunks.map(renderEvidenceChunk).join("\n\n");
    expect(text).toContain("HR. Bukhari no. 1 (Sahih — al-bukhari");
    expect(text).toContain("HR. Muslim no. 1 (Hasan — al-tirmidhi");
    // Neither passage collapsed into the other: two addresses, two grades.
    expect(text.match(/sanad:/g)).toHaveLength(2);
  });

  it("never mints the corroboration term itself — only the prompt may ask for it", () => {
    const chunk = hadithChunk("h1");
    const rendered = renderEvidenceChunk(chunk);
    expect(rendered.toLowerCase()).not.toContain("li-ghayrihi");
    // The rule is the prompt's, in both languages, and it is scoped to what the
    // context shows: a model that inferred corroboration would be inventing it.
    expect(chatSystemPrompt("en")).toMatch(/corroboration.*ONLY when the context/i);
    expect(chatSystemPrompt("id")).toMatch(/HANYA bila konteks/i);
    expect(chatSystemPrompt("en")).toMatch(/NEVER state a grade higher/);
    expect(chatSystemPrompt("id")).toMatch(/JANGAN menaikkan derajat/);
    expect(chatSystemPrompt("en")).toMatch(/takhrij/);
    expect(chatSystemPrompt("id")).toMatch(/takhrij/);
  });

  it("keeps the citation address intact when the flattened grade is stripped", () => {
    // The gate grounds the address, so stripping the grade parenthetical must not
    // touch the address itself.
    expect(citationBaseAddress("HR. Bukhari no. 1 (Sahih)")).toBe("HR. Bukhari no. 1");
    expect(citationBaseAddress("HR. Bukhari no. 1")).toBe("HR. Bukhari no. 1");
    expect(citationBaseAddress("QS. 2:255")).toBe("QS. 2:255");
  });
});
