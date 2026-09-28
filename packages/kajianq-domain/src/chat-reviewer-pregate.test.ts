import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ProviderError,
  RunContext,
  type AssembledContext,
  type Chunk,
  type Decider,
  type DecisionResult,
  type DecisionSpec,
} from "@app/rag-core";
import { parseTrace, type CostRecord, type TraceEvent } from "@app/contracts";
import { createKajianQReviewer, type KajianQReviewerDeps } from "./chat-reviewer";
import { ulamaDisclaimer } from "./chat-postprocess";
import {
  CITATION_SUPPORT_PURPOSE,
  CITATION_SUPPORT_THRESHOLD,
  claimForCitation,
  planCitationPregate,
} from "./chat-reviewer-pregate";
import { CITATION_CRITERIA, CITATION_INSTRUCTIONS } from "./decision-bench-prompts";
import type { KajianQFilters } from "./filters";

/**
 * Reviewer pre-gate at the Reviewer-stage seam (ticket #168, ADR-0042
 * adoption). External behavior only: a draft plus an injected `Decider` in,
 * verdict + trace events out. The vendor wire is never touched — the fake
 * decider is a scripted `Effect`, and the reviewer LLM is a counting stub, so
 * "was the paid reviewer called?" is a number, not an inference.
 *
 * The invariants these tests hold (named so a failure says which one broke):
 *
 *  - **fail-open**: the pre-gate can only ever *skip* the paid reviewer on an
 *    explicit all-citations-cleared answer. A low score, a missing answer, a
 *    wrong answer type, a non-finite or out-of-range score, a vendor failure,
 *    and a draft with nothing to judge all escalate. A malformed response read
 *    as a pass is the silent failure this suite exists to prevent.
 *  - **no spend before the free gate**: the deterministic validator decides
 *    first; a draft that fails it or is a generator refusal makes no decision
 *    call and no reviewer call.
 *  - **batched**: exactly one decision call per answer, one question per
 *    citation position, each question carrying its own claim + passage.
 *  - **cost-sum**: the trace total equals the sum of recorded call costs,
 *    including a *failed* vendor attempt that still spent.
 *  - **contract**: every recorded event parses against the shared trace
 *    contract — the skip and the escalation reason are persisted trace
 *    content, never server logs.
 */

const cost = (modelId: string, microUsd: number): CostRecord => ({
  modelId,
  tokensIn: 11,
  tokensOut: 0,
  latencyMs: 5,
  costMicroUsd: microUsd,
});

const chunk = (label: string, text = "passage text"): Chunk => ({
  id: `c-${label}`,
  text,
  metadata: { citation: label },
});

const context = (
  chunks: readonly Chunk[],
  intent = "Apa itu Ayat Kursi?",
): AssembledContext<KajianQFilters> => ({
  query: { intent, subQueries: [{ text: intent }], filters: {} },
  chunks,
  turns: [{ role: "user", content: chunks.map((c) => c.text).join("\n") }],
});

/** A `Decider` whose wire is a script the test owns; records every spec. */
function fakeDecider(
  respond: (spec: DecisionSpec) => Effect.Effect<DecisionResult, ProviderError>,
): { decider: Decider; calls: DecisionSpec[] } {
  const calls: DecisionSpec[] = [];
  return {
    calls,
    decider: {
      modelId: "stub-decider",
      decide: (spec) => {
        calls.push(spec);
        return respond(spec);
      },
    },
  };
}

/** A Noul answer per question key; a `null` value omits the answer entirely. */
function noulResult(scores: Record<string, number | null>, microUsd = 4): DecisionResult {
  const answers: Record<string, DecisionResult["answers"][string]> = {};
  for (const [key, score] of Object.entries(scores)) {
    if (score === null) continue;
    answers[key] = { type: "noul", noul: score };
  }
  return { answers, cost: cost("stub-decider", microUsd) };
}

/** A reviewer LLM stub that answers `pass` and counts its calls. */
function countingReviewer(): {
  provider: { generate: () => Effect.Effect<never> };
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      generate: () => {
        calls += 1;
        return Effect.succeed({
          text: '{"verdict":"pass"}',
          cost: cost("stub-reviewer", 7),
        }) as never;
      },
    },
  };
}

/** Run the reviewer stage, capturing every recorded event as a real trace. */
async function review(
  deps: KajianQReviewerDeps,
  text: string,
  chunks: readonly Chunk[],
): Promise<{ text: string; events: TraceEvent[]; totalMicroUsd: number }> {
  const events: TraceEvent[] = [];
  const reviewer = createKajianQReviewer({ applyProductRules: false, ...deps });
  const out = (await Effect.runPromise(
    Effect.provideService(reviewer.review({ text }, context(chunks)) as never, RunContext, {
      config: {},
      now: () => 1,
      record: (event: TraceEvent) => events.push(event),
    } as never) as never,
  )) as { text: string };
  // Parsing the whole event list is the contract assertion: an event shape the
  // PWA/eval readers cannot parse would throw here, not in production.
  const trace = parseTrace({ id: "trace-1", createdAt: 1, events });
  return {
    text: out.text,
    events: trace.events as TraceEvent[],
    totalMicroUsd: trace.events.reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0),
  };
}

const decisionEvent = (events: readonly TraceEvent[]) => {
  const event = events.find((e) => e.kind === "decision");
  if (event?.kind !== "decision") throw new Error("no decision event recorded");
  return event;
};
const llmCallEvents = (events: readonly TraceEvent[]) =>
  events.filter((e) => e.kind === "llm_call" && e.detail?.purpose === CITATION_SUPPORT_PURPOSE);

describe("#168 reviewer pre-gate — skip path", () => {
  it("skips the paid LLM reviewer when every citation clears the threshold", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1, c1: 0.8 })));
    const reviewer = countingReviewer();
    const out = await review(
      { provider: reviewer.provider as never, decider: pregate.decider },
      "Ayat Kursi adalah QS. 2:255. HR. Bukhari no. 1 menyebutnya.",
      [chunk("QS. 2:255", "ayat"), chunk("HR. Bukhari no. 1", "hadith")],
    );
    expect(reviewer.calls()).toBe(0);
    expect(pregate.calls).toHaveLength(1);
    expect(decisionEvent(out.events).detail.outcome).toBe("skip");
    // The answer is delivered as the draft produced it (rules disabled here).
    expect(out.text).toContain("QS. 2:255");
  });

  it("records the pre-gate call's cost, model identity and per-citation scores", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 0.9, c1: 0.5 }, 13)));
    const { decider } = pregate;
    const out = await review(
      { provider: countingReviewer().provider as never, decider },
      "Ayat Kursi QS. 2:255 dan hadith HR. Bukhari no. 1.",
      [chunk("QS. 2:255"), chunk("HR. Bukhari no. 1")],
    );
    const calls = llmCallEvents(out.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cost).toMatchObject({ modelId: "stub-decider", costMicroUsd: 13 });
    const decision = decisionEvent(out.events);
    expect(decision.detail.purpose).toBe(CITATION_SUPPORT_PURPOSE);
    expect(decision.detail.threshold).toBe(CITATION_SUPPORT_THRESHOLD);
    expect(decision.detail.items).toEqual([
      { index: 0, key: "QS. 2:255", score: 0.9 },
      { index: 1, key: "HR. Bukhari no. 1", score: 0.5 },
    ]);
    expect(out.totalMicroUsd).toBe(13);
  });

  it("treats exactly the threshold as supported and just below it as unsupported", async () => {
    const atThreshold = await review(
      {
        provider: countingReviewer().provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 0.5 }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(decisionEvent(atThreshold.events).detail.outcome).toBe("skip");

    const reviewer = countingReviewer();
    const belowThreshold = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 0.499 }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(decisionEvent(belowThreshold.events).detail.outcome).toBe("escalate");
    expect(belowThreshold.events.some((e) => e.kind === "review")).toBe(true);
  });

  it("records a product_rules event on the skip path when the rules are on (#285)", async () => {
    // The skip path reaches the rules through `withRules` and records no
    // `review` event — so this event is the only trace evidence that the
    // deterministic controls ran on an answer the cheap screen cleared.
    const out = await review(
      {
        applyProductRules: true,
        provider: countingReviewer().provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 1 }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    const event = out.events.find((e) => e.kind === "product_rules");
    if (event?.kind !== "product_rules") throw new Error("no product_rules event recorded");
    expect(event.stage).toBe("reviewer");
    expect(event.detail.applied).toEqual(["ulama_disclaimer"]);
    expect(out.text).toContain(ulamaDisclaimer("id"));
  });

  it("records no product_rules event when the deterministic rules are disabled (#285)", async () => {
    // The same skip path with `applyProductRules: false` (this suite's default
    // wiring): the event means "the rules ran", so a run that skips them must
    // not look like one that fired them — even though every rule would
    // otherwise have appended something here.
    const out = await review(
      {
        provider: countingReviewer().provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 1 }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(decisionEvent(out.events).detail.outcome).toBe("skip");
    expect(out.events.some((e) => e.kind === "product_rules")).toBe(false);
    expect(out.text).not.toContain(ulamaDisclaimer("id"));
  });
});

describe("#168 reviewer pre-gate — escalation path (fail-open)", () => {
  it("escalates to the LLM reviewer when a citation scores below the threshold", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 1, c1: 0.2 }))).decider,
      },
      "Ayat Kursi QS. 2:255 dan hadith HR. Bukhari no. 1.",
      [chunk("QS. 2:255"), chunk("HR. Bukhari no. 1")],
    );
    expect(reviewer.calls()).toBe(1);
    const decision = decisionEvent(out.events);
    expect(decision.detail.outcome).toBe("escalate");
    expect(decision.detail.reason).toBe("below_threshold");
    // Both calls are on the trace: the screen's cost and the escalated review.
    expect(llmCallEvents(out.events)).toHaveLength(1);
    expect(out.totalMicroUsd).toBe(4 + 7);
  });

  it("fails open when the decision vendor fails, keeping the attempt's cost on the trace", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() =>
          Effect.fail(
            new ProviderError({
              kind: "rate_limited",
              message: "429 from the decision vendor",
              attemptCosts: [cost("stub-decider", 3)],
            }),
          ),
        ).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(reviewer.calls()).toBe(1);
    const decision = decisionEvent(out.events);
    expect(decision.detail.outcome).toBe("escalate");
    expect(decision.detail.reason).toBe("vendor_failure");
    // The failed attempt reached the vendor, so its spend stays on the trail.
    expect(llmCallEvents(out.events)).toHaveLength(1);
    expect(llmCallEvents(out.events)[0]?.cost?.costMicroUsd).toBe(3);
    expect(out.totalMicroUsd).toBe(3 + 7);
    // The planned items are listed unscored: the request was built, no
    // judgment came back — never an implicit pass.
    expect(decision.detail.items).toEqual([{ index: 0, key: "QS. 2:255" }]);
  });

  it("fails open when the vendor omits an answer for one citation", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 1, c1: null }))).decider,
      },
      "Ayat Kursi QS. 2:255 dan hadith HR. Bukhari no. 1.",
      [chunk("QS. 2:255"), chunk("HR. Bukhari no. 1")],
    );
    expect(reviewer.calls()).toBe(1);
    const decision = decisionEvent(out.events);
    expect(decision.detail.reason).toBe("malformed_answer");
    expect(decision.detail.items?.[1]).toEqual({ index: 1, key: "HR. Bukhari no. 1" });
  });

  it("fails open when the vendor answers a citation with the wrong answer type", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() =>
          Effect.succeed({
            answers: {
              c0: { type: "choice", choice: "c0", probabilities: {}, confidence: 0.9 },
            },
            cost: cost("stub-decider", 4),
          }),
        ).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(reviewer.calls()).toBe(1);
    expect(decisionEvent(out.events).detail.reason).toBe("malformed_answer");
  });

  it("fails open when the vendor returns a non-finite score", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: Number.NaN }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(reviewer.calls()).toBe(1);
    const decision = decisionEvent(out.events);
    expect(decision.detail.reason).toBe("malformed_answer");
    expect(decision.detail.items?.[0]).toEqual({ index: 0, key: "QS. 2:255" });
  });

  it("fails open on an out-of-range Noul instead of reading it as support (A2)", async () => {
    // The seam documents Noul 0..1. `5` is finite, so a finiteness-only read
    // scores it above the threshold and SKIPS the paid reviewer — shipping the
    // draft unreviewed. Out of range is an unusable item, never a pass.
    for (const outOfRange of [5, -0.01]) {
      const reviewer = countingReviewer();
      const out = await review(
        {
          provider: reviewer.provider as never,
          decider: fakeDecider(() => Effect.succeed(noulResult({ c0: outOfRange }))).decider,
        },
        "Lihat QS. 2:255.",
        [chunk("QS. 2:255")],
      );
      expect(reviewer.calls(), `noul ${outOfRange} must not skip the reviewer`).toBe(1);
      const decision = decisionEvent(out.events);
      expect(decision.detail).toMatchObject({ outcome: "escalate", reason: "malformed_answer" });
      expect(decision.detail.items?.[0]).toEqual({ index: 0, key: "QS. 2:255" });
    }
  });

  it("makes no decision call for a zero-citation draft and escalates", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({})));
    const reviewer = countingReviewer();
    const out = await review(
      { provider: reviewer.provider as never, decider: pregate.decider },
      "Jawaban tanpa sitasi apa pun.",
      [chunk("QS. 2:255")],
    );
    expect(pregate.calls).toHaveLength(0);
    expect(reviewer.calls()).toBe(1);
    const decision = decisionEvent(out.events);
    expect(decision.detail).toMatchObject({ outcome: "escalate", reason: "no_items" });
    expect(decision.detail.items).toEqual([]);
  });
});

describe("#168 reviewer pre-gate — request shape", () => {
  it("makes exactly one batched decision call for many citations", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1, c1: 1, c2: 1, c3: 1 })));
    await review(
      { provider: countingReviewer().provider as never, decider: pregate.decider },
      "QS. 2:255, HR. Bukhari no. 1, HR. Muslim no. 2 dan HR. Abu Dawud no. 3.",
      [
        chunk("QS. 2:255"),
        chunk("HR. Bukhari no. 1"),
        chunk("HR. Muslim no. 2"),
        chunk("HR. Abu Dawud no. 3"),
      ],
    );
    expect(pregate.calls).toHaveLength(1);
    expect(Object.keys(pregate.calls[0]?.questions ?? {})).toEqual(["c0", "c1", "c2", "c3"]);
  });

  it("keys one question per citation position and carries its claim and passage", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1, c1: 1 })));
    await review(
      { provider: countingReviewer().provider as never, decider: pregate.decider },
      "Ayat Kursi adalah QS. 2:255. Hadithnya HR. Bukhari no. 1.",
      [chunk("QS. 2:255", "ayat kursi passage"), chunk("HR. Bukhari no. 1", "bukhari passage")],
    );
    const spec = pregate.calls[0];
    if (!spec) throw new Error("no decision spec");
    const state = spec.state as { citations: { claim: string; passage: string }[] };
    expect(state.citations).toHaveLength(2);
    expect(state.citations[0]?.claim).toContain("Ayat Kursi adalah QS. 2:255");
    expect(state.citations[0]?.passage).toBe("ayat kursi passage");
    expect(state.citations[1]?.claim).toContain("Hadithnya HR. Bukhari no. 1");
    expect(state.citations[1]?.passage).toBe("bukhari passage");
  });

  it("asks the same benchmarked citation question the ADR-0042 gate scored", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1 })));
    await review(
      { provider: countingReviewer().provider as never, decider: pregate.decider },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(pregate.calls[0]?.questions.c0).toEqual({
      type: "noul",
      instructions: CITATION_INSTRUCTIONS,
      criteria: { ...CITATION_CRITERIA },
    });
    // The claim spans and cited passages are the user's answer text, so the
    // spec declares personal data (ADR-0043): the seam can then refuse a
    // vendor whose config forbids it (A1).
    expect(pregate.calls[0]?.personalData).toBe(true);
  });

  it("turns one repeated citation mention into one question", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1 })));
    await review(
      { provider: countingReviewer().provider as never, decider: pregate.decider },
      "QS. 2:255 adalah Ayat Kursi. Sekali lagi: QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(Object.keys(pregate.calls[0]?.questions ?? {})).toEqual(["c0"]);
  });

  it("ignores an extra answer key the vendor volunteered", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      {
        provider: reviewer.provider as never,
        decider: fakeDecider(() => Effect.succeed(noulResult({ c0: 1, unexpected: 0 }))).decider,
      },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(reviewer.calls()).toBe(0);
    expect(decisionEvent(out.events).detail.outcome).toBe("skip");
  });

  it("orders citations by their position in the draft, not by grammar", () => {
    const plan = planCitationPregate({
      draft: "HR. Bukhari no. 1 dulu, baru QS. 2:255.",
      chunks: [chunk("QS. 2:255"), chunk("HR. Bukhari no. 1")],
    });
    expect(plan?.items.map((item) => item.label)).toEqual(["HR. Bukhari no. 1", "QS. 2:255"]);
  });

  it("masks citations before splitting so a citation cannot cut its own claim span", () => {
    const plan = planCitationPregate({
      draft: "Ayat Kursi adalah QS. 2:255 yang agung.",
      chunks: [chunk("QS. 2:255")],
    });
    const claim = plan?.items[0]?.claim ?? "";
    expect(claim).toContain("QS. 2:255");
    expect(claim).toContain("Ayat Kursi adalah");
  });
});

describe("#168 reviewer pre-gate — order, absence and cost discipline", () => {
  it("never spends on the pre-gate when the deterministic validator refuses", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({})));
    const reviewer = countingReviewer();
    const out = await review(
      { provider: reviewer.provider as never, decider: pregate.decider },
      "Menurut QS. 9:99 …",
      [chunk("QS. 2:255")],
    );
    expect(pregate.calls).toHaveLength(0);
    expect(reviewer.calls()).toBe(0);
    expect(out.events.some((e) => e.kind === "decision")).toBe(false);
    expect(out.events.some((e) => e.kind === "refusal")).toBe(true);
    expect(out.totalMicroUsd).toBe(0);
  });

  it("never spends on the pre-gate for a generator-emitted refusal", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({})));
    const reviewer = countingReviewer();
    // The canonical insufficiency refusal carries no citation at all.
    const out = await review(
      { provider: reviewer.provider as never, decider: pregate.decider },
      "Maaf, saya tidak menemukan dalil yang memadai untuk menjawab pertanyaan ini.",
      [chunk("QS. 2:255")],
    );
    expect(pregate.calls).toHaveLength(0);
    expect(reviewer.calls()).toBe(0);
    expect(out.events.some((e) => e.kind === "refusal")).toBe(true);
  });

  it("behaves exactly as before adoption when no decision model is wired", async () => {
    const reviewer = countingReviewer();
    const out = await review(
      { provider: reviewer.provider as never, decider: null },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(reviewer.calls()).toBe(1);
    expect(out.events.some((e) => e.kind === "decision")).toBe(false);
    expect(out.totalMicroUsd).toBe(7);
  });

  it("does not screen an answer whose LLM reviewer is unwired or skipped", async () => {
    const pregate = fakeDecider(() => Effect.succeed(noulResult({ c0: 1 })));
    const unwired = await review({ provider: null, decider: pregate.decider }, "Lihat QS. 2:255.", [
      chunk("QS. 2:255"),
    ]);
    const skipped = await review(
      { provider: countingReviewer().provider as never, decider: pregate.decider, skipLlm: true },
      "Lihat QS. 2:255.",
      [chunk("QS. 2:255")],
    );
    expect(pregate.calls).toHaveLength(0);
    expect(unwired.events.some((e) => e.kind === "decision")).toBe(false);
    expect(skipped.events.some((e) => e.kind === "decision")).toBe(false);
  });
});

describe("#168 reviewer pre-gate — claim spans (domain grammar)", () => {
  it("picks the sentence carrying the citation as the claim", () => {
    const spans = ["Ayat Kursi adalah QS. 2:255.", "Hadithnya HR. Bukhari no. 1."];
    expect(claimForCitation(spans, "QS. 2:255")).toBe(spans[0]);
    expect(claimForCitation(spans, "HR. Bukhari no. 1")).toBe(spans[1]);
  });

  it("grounds the claim span the same way the deterministic gate grounds a label", () => {
    // The model wrote the dot-less spelling; the gate canonicalizes it, so the
    // pre-gate must find the claim instead of falling back to the whole draft.
    const plan = planCitationPregate({
      draft: "Pertama. Ayat Kursi ada di QS 2:255. Terakhir.",
      chunks: [chunk("QS. 2:255")],
    });
    expect(plan?.items[0]?.claim).toBe("Ayat Kursi ada di QS 2:255.");
  });

  it("joins every passage a citation label grounds, and no other", () => {
    const plan = planCitationPregate({
      draft: "Lihat QS. 2:255.",
      chunks: [
        chunk("QS. 2:255", "first"),
        chunk("QS. 2:255", "second"),
        chunk("QS. 9:99", "other"),
      ],
    });
    expect(plan?.items[0]?.passage).toBe("first\n\nsecond");
  });

  it("carries the passage for a citation written with an introducing colon (#253)", () => {
    // The tail is normalized on both sides, so a draft citation the gate
    // grounds also finds its chunk's passage here. Before #253's fix the colon
    // survived into the item's key, the map lookup missed, and the paid
    // decision call judged this citation against an EMPTY passage.
    const plan = planCitationPregate({
      draft: "Rasulullah bersabda dalam HR. Bukhari no. 5010: matn hadith.",
      chunks: [chunk("HR. Bukhari no. 5010", "bukhari passage")],
    });
    expect(plan?.items.map((item) => item.label)).toEqual(["HR. Bukhari no. 5010"]);
    expect(plan?.items[0]?.passage).toBe("bukhari passage");
    expect(plan?.items[0]?.claim).toContain("HR. Bukhari no. 5010:");
  });

  it("carries the passage for a citation written with a footnote tail (A2)", () => {
    // Same seam, one class further: a footnote digit is not address, so the
    // item is keyed by the reduced label and the passage lookup hits. Before
    // the grammar-address fix (review A2) the key kept `:1`, the map lookup
    // missed, and the paid call judged the citation against an EMPTY passage.
    const plan = planCitationPregate({
      draft: "Rasulullah bersabda dalam HR. Bukhari no. 5010:1 matn hadith.",
      chunks: [chunk("HR. Bukhari no. 5010", "bukhari passage")],
    });
    expect(plan?.items.map((item) => item.label)).toEqual(["HR. Bukhari no. 5010"]);
    expect(plan?.items[0]?.passage).toBe("bukhari passage");
    expect(plan?.items[0]?.claim).toContain("HR. Bukhari no. 5010:1");
  });
});
