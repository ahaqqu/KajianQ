import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
import {
  behaviorAccepted,
  citationLabelsPresent,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  refusalCorrectness,
  retrievalRecall,
} from "./scorers";
import { scoreQuestion } from "./harness";
import type { GoldenQuestion } from "@app/contracts";
import type { CitationFrameLike, CitationGrammar, TraceEventLike } from "./harness-types";
import { CitationGrammarError } from "./citation-grammar";

const question: GoldenQuestion = {
  id: "gs-test-1",
  question: "test question",
  language: "id",
  expectedSourceTypes: ["source-a", "source-b"],
  requiredCitations: ["label-1"],
  expectedBehavior: "answer",
};

describe("retrievalRecall", () => {
  it("scores 1 when every expected source type was retrieved", () => {
    const recall = retrievalRecall(["source-a", "source-b"], [{ id: "c1" }, { id: "c2" }], (id) =>
      id === "c1" ? "source-a" : "source-b",
    );
    expect(recall).toBe(1);
  });

  it("scores partially when only some expected types were retrieved", () => {
    const recall = retrievalRecall(["source-a", "source-b"], [{ id: "c1" }], () => "source-a");
    expect(recall).toBe(0.5);
  });

  it("scores 0 when nothing expected was retrieved", () => {
    const recall = retrievalRecall(["source-a"], [{ id: "c1" }], () => "source-c");
    expect(recall).toBe(0);
  });

  it("scores 1 for a question with no expected sources", () => {
    const recall = retrievalRecall([], [], () => undefined);
    expect(recall).toBe(1);
  });
});

describe("citationValidity", () => {
  it("scores 1 when all required citations appear in the answer", () => {
    expect(citationValidity(["label-1", "label-2"], "… label-1 … label-2 …")).toBe(1);
  });

  it("scores partially when a citation is missing", () => {
    expect(citationValidity(["label-1", "label-2"], "label-1 only")).toBe(0.5);
  });

  it("scores 1 when no citations are required", () => {
    expect(citationValidity([], "anything")).toBe(1);
  });

  /**
   * The text-fallback path with the gate's grammar injected (the CLI wiring).
   * The grammar is faked here — the engine package must not depend on the
   * domain pack — and its shape mirrors the real `normalizeCitationLabel` /
   * `citationCandidatesIn` pair, canonicalizing the marker spellings the way
   * the real functions do.
   */
  const canon = (label: string): string =>
    label
      .replace(/[*_`]+/g, "")
      .replace(/\bQ\.?S\.?(?=\s)/g, "QS.")
      .replace(/\s+/g, " ")
      .trim();
  const grammar = {
    normalizeLabel: canon,
    labelsInText: (text: string) =>
      [...text.matchAll(/Q\.?S\.?\s*[^\s:,[\]()]+\s*:\s*\d+/g)].map((m) => canon(m[0]!)),
    // No list-valued citation form in this double, declared as such (the
    // member is required — review R1; a grammar with ranges declares its
    // enumeration instead, see `rangeGrammar` below).
    addressesNamedBy: (label: string): readonly string[] => [label],
  };

  it("matches a marker-spelling variant the raw substring check misses", () => {
    // Live-staging shape: the fixture curates `QS. 1:2`, but a model (or the
    // store's label) may carry the dotted `Q.S.` or the dot-less `QS ` form.
    // `"… Q.S. 1:2 …".includes("QS. 1:2")` is false — a grounded citation
    // scored 0 on spelling alone. The grammar canonicalizes both sides.
    expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …", { grammar })).toBe(1);
    expect(citationValidity(["QS. 1:2"], "… QS 1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… QS 1:2 …", { grammar })).toBe(1);
  });

  it("ignores whitespace reflow between the marker and the address", () => {
    expect(citationValidity(["QS. 1:2"], "… QS.  1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… QS.  1:2 …", { grammar })).toBe(1);
  });

  it("normalizes the required label too, so a marker variant matches", () => {
    // The fixture's own spelling may carry the variant; the text's standard.
    expect(citationValidity(["Q.S. 1:2"], "… QS. 1:2 …", { grammar })).toBe(1);
  });

  it("uses the citations frame when one is present, over the text", () => {
    // The frame is the server's grounded set; its labels win outright.
    const frame = { citations: [{ label: "QS. 1:2" }] };
    expect(citationValidity(["QS. 1:2"], "no citation in this text at all", { frame })).toBe(1);
  });

  it("NEVER scores a label the frame does not contain (ADR-0040 invariant)", () => {
    // A frame that grounds nothing cannot be talked into a pass by text that
    // happens to contain the label — a fabricated citation is not grounded.
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(citationValidity(["QS. 1:2"], "the text writes QS. 1:2 plainly", { frame })).toBe(0);
  });

  it("scores a hybrid refusal's frame on its citations, never on the refusal flag (#436)", () => {
    // The gate-affecting statement of #436, as a test: a generator-emitted
    // refusal inside a partial answer ships a frame that carries BOTH the
    // grounded labels the text quotes and `refusal: true`. The scorer reads the
    // list and ignores the flag, so the citations the delivered text actually
    // carries are scored — the shape used to score 0 off the frame's old
    // empty-on-any-refusal derivation. The refusal dimension is untouched: it
    // reads the trace's `refusal` event, not this frame.
    const hybridFrame = { refusal: true, citations: [{ label: "QS. 1:2" }] };
    expect(
      citationValidity(["QS. 1:2"], "… QS. 1:2 … lalu tidak menemukan dalil", {
        frame: hybridFrame,
      }),
    ).toBe(1);
    // The unchanged good case: a pure refusal's frame is genuinely empty, and
    // its required citations stay absent — the same 0 it has always scored.
    const pureRefusalFrame = { refusal: true, citations: [] as { label: string }[] };
    expect(
      citationValidity(["QS. 1:2"], "tidak menemukan dalil yang memadai", {
        frame: pureRefusalFrame,
      }),
    ).toBe(0);
  });

  it("scores a label absent from a non-empty frame as absent even when normalized", () => {
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(citationValidity(["QS. 1:2"], "… **QS. 1:2** …", { frame, grammar })).toBe(0);
  });

  it("falls back to the trace's grounded labels when there is no frame", () => {
    const events: TraceEventLike[] = [
      {
        kind: "review",
        stage: "reviewer",
        detail: { verdict: "{}", grounded: ["QS. 1:2", "HR. Malik no. 187"] },
      },
    ];
    expect(citationValidity(["QS. 1:2"], "text without any marker", { events })).toBe(1);
  });

  it("treats an EMPTY grounded list as evidence of nothing, not as absent", () => {
    // A refusal records an empty `grounded` list; scoring must not fall through
    // to the text (which for a refusal is a refusal marker, not a citation).
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: [] } },
    ];
    expect(citationValidity(["QS. 1:2"], "QS. 1:2 appears in the refusal text", { events })).toBe(
      0,
    );
  });

  it("falls back to the text when an older trace has no grounded field", () => {
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}" } },
    ];
    expect(citationValidity(["QS. 1:2"], "cites QS. 1:2", { events })).toBe(1);
  });

  it("prefers the frame over the trace's grounded labels", () => {
    const frame = { citations: [] as { label: string }[] };
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: ["QS. 1:2"] } },
    ];
    expect(citationValidity(["QS. 1:2"], "QS. 1:2", { frame, events })).toBe(0);
  });

  /**
   * The three evidence paths on a **grounded range** (review A1 of the #274 fix
   * round). The reviewer's reproduction at head: with `QS. 2:255-256` grounded
   * by the retrieved `QS. 2:255` + `QS. 2:256`, `citationValidity(["QS. 2:255"],
   * answer, { frame })` was **0** — the frame carries the range as written
   * (ADR-0049 Decision 4) and the required citation is the single verse, so
   * comparing the two as strings scored a correctly grounded answer absent
   * while the same call through the trace's `grounded` labels scored 1. The
   * required citation and the evidence are now compared as the **sets of
   * addresses they name**, through the same declaration the gate grounds with.
   *
   * The grammar double above gains that declaration (mirroring the domain
   * pack's `addressesNamedBy`, the function the CLI composition root injects),
   * and `labelsInText` gains the dash tail so the text path sees the same span
   * the real scan produces.
   */
  describe("a grounded range on every evidence path (#274 A1)", () => {
    const rangeGrammar = {
      ...grammar,
      labelsInText: (text: string) =>
        [...text.matchAll(/Q\.?S\.?\s*[^\s:,[\]()]+\s*:\s*\d+(?:-\d+)*/g)].map((m) => canon(m[0]!)),
      addressesNamedBy: (label: string): readonly string[] => {
        const m = /^(Q\.?S\.?\s*[^\s:,[\]()]+\s*:\s*)(\d+)(?:-(\d+))?$/.exec(label);
        if (m === null || m[3] === undefined) return [label];
        const lo = Math.min(Number(m[2]), Number(m[3]));
        const hi = Math.max(Number(m[2]), Number(m[3]));
        const out: string[] = [];
        for (let n = lo; n <= hi; n += 1) out.push(`${m[1]}${n}`);
        return out;
      },
    };
    const answer = "Dalilnya QS. 2:255-256 tentang hal ini.";
    // What `deriveCitationsFrame` emits for this answer: the range as written,
    // backed by its head verse's display row (pinned end-to-end against the
    // real frame in `apps/api/src/lib/chat-citations.test.ts`).
    const rangeFrame = { citations: [{ label: "QS. 2:255-256" }] };
    // What the gate records on the trace: every address the grounded range
    // cites, head and tail.
    const events: TraceEventLike[] = [
      {
        kind: "review",
        stage: "reviewer",
        detail: { verdict: "{}", grounded: ["QS. 2:255", "QS. 2:256"] },
      },
    ];

    it("scores the head verse 1 on the frame path, the events path and the text path", () => {
      expect(
        citationValidity(["QS. 2:255"], answer, { frame: rangeFrame, grammar: rangeGrammar }),
      ).toBe(1);
      expect(citationValidity(["QS. 2:255"], answer, { events, grammar: rangeGrammar })).toBe(1);
      expect(citationValidity(["QS. 2:255"], answer, { grammar: rangeGrammar })).toBe(1);
    });

    it("scores the TAIL verse too — the range cites it, and it is never a literal substring", () => {
      // `"… QS. 2:255-256 …".includes("QS. 2:256")` is false, which is why the
      // provenance list has to name every address a grounded range cites.
      expect(answer.includes("QS. 2:256")).toBe(false);
      expect(
        citationValidity(["QS. 2:256"], answer, { frame: rangeFrame, grammar: rangeGrammar }),
      ).toBe(1);
      expect(citationValidity(["QS. 2:256"], answer, { events, grammar: rangeGrammar })).toBe(1);
      expect(citationValidity(["QS. 2:256"], answer, { grammar: rangeGrammar })).toBe(1);
    });

    it("still scores an address the range does NOT name as absent", () => {
      // The relation only widens to what the range names: 2:257 is outside it.
      expect(
        citationValidity(["QS. 2:257"], answer, { frame: rangeFrame, grammar: rangeGrammar }),
      ).toBe(0);
      expect(citationValidity(["QS. 2:257"], answer, { events, grammar: rangeGrammar })).toBe(0);
    });

    it("refuses a declared-but-unenumerable list on both sides of the comparison (review T1)", () => {
      // The declaration's third state, from the domain pack: a grammar that
      // declares a list and cannot enumerate it returns `null`. That is a
      // REFUSAL — not `[]` ("names nothing", which falls back to the label) and
      // not a one-element list (a single-address declaration). The engine must
      // not read a shorter version of such a label in either direction, or the
      // scorer would credit an answer the gate refused.
      const unenumerable: CitationGrammar = {
        ...rangeGrammar,
        addressesNamedBy: (label: string): readonly string[] | null =>
          label.includes("-") ? null : [label],
      };
      // As EVIDENCE a `null` label names nothing verifiable, so it grounds
      // nothing — here the frame's range label cannot ground its own head.
      const frame = { citations: [{ label: "QS. 2:255-256" }] };
      expect(citationValidity(["QS. 2:255"], answer, { frame, grammar: unenumerable })).toBe(0);
      // As a REQUIRED citation it is never present, even though the answer text
      // contains its head and the evidence carries the range.
      expect(
        citationValidity(["QS. 2:255-256"], answer, { frame: rangeFrame, grammar: unenumerable }),
      ).toBe(0);
      expect(citationValidity(["QS. 2:255-256"], answer, { grammar: unenumerable })).toBe(0);
      // `[]` is NOT `null`: a grammar that names nothing for a label still
      // compares that label whole — the pre-existing fallback, unchanged.
      const namesNothing: CitationGrammar = { ...rangeGrammar, addressesNamedBy: () => [] };
      expect(
        citationValidity(["QS. 2:255-256"], answer, { frame: rangeFrame, grammar: namesNothing }),
      ).toBe(1);
    });

    it("keeps the frame authoritative: an empty frame is still 0", () => {
      // The frame is the server's grounded set; the new relation reads its
      // labels, it does not replace the frame with the answer text.
      const empty = { citations: [] as { label: string }[] };
      expect(
        citationValidity(["QS. 2:255"], answer, { frame: empty, events, grammar: rangeGrammar }),
      ).toBe(0);
    });

    /**
     * R1 of the fix round: the declaration is required, and its absence is a
     * loud typed error at the engine's grammar entry — never the silent
     * string-only fallback that reproduced A1. Measured at head 171b858 with
     * the real domain grammar and the real `deriveCitationsFrame` output on
     * this fixture: declaration present 1/1/1 (frame/events/text), declaration
     * absent 0/1/0. The fallback is deleted, not weakened.
     */
    const withoutDeclaration = (): CitationGrammar =>
      ({
        normalizeLabel: rangeGrammar.normalizeLabel,
        labelsInText: rangeGrammar.labelsInText,
      }) as unknown as CitationGrammar;

    it("throws a typed error when the grammar omits the declaration, on every evidence path", () => {
      for (const evidence of [{ frame: rangeFrame }, { events }, {}]) {
        expect(() =>
          citationValidity(["QS. 2:255"], answer, { ...evidence, grammar: withoutDeclaration() }),
        ).toThrow(CitationGrammarError);
      }
    });

    it("names the missing member, so the injector can be fixed without guessing", () => {
      try {
        citationValidity(["QS. 2:255"], answer, {
          frame: rangeFrame,
          grammar: withoutDeclaration(),
        });
        expect.unreachable("the engine scored with an unwired grammar");
      } catch (error) {
        expect(error).toBeInstanceOf(CitationGrammarError);
        expect((error as CitationGrammarError).kind).toBe("citation_grammar_missing_naming");
        expect((error as Error).message).toContain("addressesNamedBy");
        expect((error as Error).name).toBe("CitationGrammarError");
      }
    });

    it("fails even on a question with no required citations (no silent short-circuit)", () => {
      // `citationValidity` returns 1 before touching the grammar when nothing
      // is required; the guard runs BEFORE that, so an unwired grammar cannot
      // hide behind a trap question and surface on a later one.
      expect(() => citationValidity([], answer, { grammar: withoutDeclaration() })).toThrow(
        CitationGrammarError,
      );
    });
  });
});

describe("citationLabelsPresent", () => {
  const frameOf = (labels: string[]): CitationFrameLike => ({
    citations: labels.map((label) => ({ label })),
  });

  it("returns the required labels the frame grounds, in the fixture's spelling", () => {
    expect(
      citationLabelsPresent({
        required: ["QS. 1:2", "HR. Malik no. 187"],
        answerText: "irrelevant",
        frame: frameOf(["QS. 1:2"]),
      }),
    ).toEqual(["QS. 1:2"]);
  });

  it("normalizes both sides of the frame comparison", () => {
    // The fixture keeps the curated `QS. 1:2`; a frame label in a marker
    // variant still grounds it once the grammar canonicalizes both.
    expect(
      citationLabelsPresent({
        required: ["QS. 1:2"],
        answerText: "",
        frame: frameOf(["Q.S.  1:2"]),
        grammar: {
          normalizeLabel: (label) => label.replace(/\s+/g, " ").replace("Q.S.", "QS."),
          labelsInText: () => [],
          addressesNamedBy: (label) => [label],
        },
      }),
    ).toEqual(["QS. 1:2"]);
  });

  it("keeps the byte-exact substring behavior when no grammar is injected", () => {
    expect(
      citationLabelsPresent({ required: ["QS. 1:2"], answerText: "cites **QS. 1:2**" }),
    ).toEqual(["QS. 1:2"]);
    expect(citationLabelsPresent({ required: ["QS. 1:2"], answerText: "cites Q.S. 1:2" })).toEqual(
      [],
    );
  });

  it("refuses at its own entry a grammar that cannot say what a label names (R1)", () => {
    expect(() =>
      citationLabelsPresent({
        required: ["QS. 1:2"],
        answerText: "",
        frame: frameOf(["QS. 1:2"]),
        grammar: {
          normalizeLabel: (label: string) => label,
          labelsInText: () => [],
        } as unknown as CitationGrammar,
      }),
    ).toThrow(CitationGrammarError);
  });
});

describe("refusalCorrectness", () => {
  it("passes when a refusal case refuses", () => {
    expect(refusalCorrectness("refuse", true)).toBe(true);
  });
  it("fails when a refusal case answers", () => {
    expect(refusalCorrectness("refuse", false)).toBe(false);
  });
  it("passes when an answer case answers", () => {
    expect(refusalCorrectness("answer", false)).toBe(true);
  });
});

describe("detectRefusal", () => {
  it("detects a trace refusal event", () => {
    expect(detectRefusal([{ kind: "refusal", stage: "generator" }], "", [])).toBe(true);
  });
  it("detects a refusal marker in the text", () => {
    expect(
      detectRefusal([], "tidak menemukan dalil yang memadai", [
        "tidak menemukan dalil yang memadai",
      ]),
    ).toBe(true);
  });
  it("is false for a plain answer", () => {
    expect(
      detectRefusal([{ kind: "retrieval", stage: "retriever" }], "a confident answer", [
        "no match",
      ]),
    ).toBe(false);
  });
});

describe("groundedAnswer (#250: the non-refusal branch)", () => {
  const frameOf = (labels: string[]): CitationFrameLike => ({
    citations: labels.map((label) => ({ label })),
  });
  const reviewWith = (grounded: string[] | undefined): TraceEventLike => ({
    kind: "review",
    stage: "reviewer",
    detail: grounded === undefined ? { verdict: "{}" } : { verdict: "{}", grounded },
  });

  it("is true when the frame grounds at least one citation", () => {
    expect(groundedAnswer({ frame: frameOf(["QS. 55:1"]) })).toBe(true);
  });

  it("is false for an EMPTY frame, even when the trace's grounded list is not", () => {
    // Frame-first precedence, exactly as `citationLabelsPresent`: an empty frame
    // is authoritative and the trace labels are never consulted past it. This is
    // the direction that cannot manufacture a pass from a fabricated citation.
    expect(groundedAnswer({ frame: frameOf([]), events: [reviewWith(["QS. 55:1"])] })).toBe(false);
  });

  it("falls back to the trace's grounded labels when no frame was carried", () => {
    expect(groundedAnswer({ frame: null, events: [reviewWith(["QS. 55:1"])] })).toBe(true);
  });

  it("treats an EMPTY grounded list as evidence of nothing", () => {
    expect(groundedAnswer({ frame: null, events: [reviewWith([])] })).toBe(false);
  });

  it("is false when the trace carries no review event at all", () => {
    expect(groundedAnswer({ events: [{ kind: "retrieval", stage: "retriever" }] })).toBe(false);
  });

  it("is false for an older trace with no grounded field — the text never grounds itself", () => {
    // The one shape `groundedAnswer` takes no answer text for: a citation-shaped
    // span in the prose is not evidence (a fabricated citation is shaped the
    // same way), so there is deliberately no text fallback here.
    expect(groundedAnswer({ frame: null, events: [reviewWith(undefined)] })).toBe(false);
  });
});

describe("behaviorAccepted (#250: refuse, or ground it)", () => {
  it("passes a trap on a bare refusal — a refusal carries no citations by design", () => {
    expect(behaviorAccepted("refuse", true, false)).toBe(true);
  });

  it("passes a trap on a grounded decline — the paraphrase exact-prose matching scored as an answer", () => {
    expect(behaviorAccepted("refuse", false, true)).toBe(true);
  });

  it("fails a trap on a non-refusal with no grounded citation — this keeps the gate live", () => {
    // `gs-v0-019` has no required citations and no expected source types, so
    // this dimension is its only live check: accepting any non-refusal would
    // make the question a no-op that always passes.
    expect(behaviorAccepted("refuse", false, false)).toBe(false);
  });

  it("fails an answerable question that is refused, grounded or not (over-refusal)", () => {
    expect(behaviorAccepted("answer", true, false)).toBe(false);
    expect(behaviorAccepted("answer", true, true)).toBe(false);
  });

  it("accepts an answerable question that answers, ignoring the grounded flag", () => {
    expect(behaviorAccepted("answer", false, false)).toBe(true);
    expect(behaviorAccepted("answer", false, true)).toBe(true);
  });
});

describe("scoreQuestion", () => {
  const retrievalEvent: TraceEventLike = {
    kind: "retrieval",
    stage: "retriever",
    detail: { chunks: [{ id: "c1" }, { id: "c2" }] },
  };

  it("passes a fully correct answer", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.retrievalRecall).toBe(1);
    expect(outcome.citationValidity).toBe(1);
  });

  it("fails when the required citation is missing", () => {
    const outcome = scoreQuestion(question, "no citation here", [retrievalEvent], {
      sourceTypeOf: () => "source-a",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.citationValidity).toBe(0);
  });

  it("scores recall 0 when no retrieval event exists in the trace", () => {
    const outcome = scoreQuestion(question, "label-1", [], {
      sourceTypeOf: () => undefined,
    });
    expect(outcome.retrievalRecall).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it("records the expansion's contribution beside the unchanged metric (C1)", () => {
    // The mask is real: `retrievalRecall` reads every ref regardless of
    // origin, so the two expansion refs satisfy the second expected source.
    // The outcome must still say WHICH path carried it — that is the whole
    // point of the extra block.
    const scoped: TraceEventLike = {
      kind: "retrieval",
      stage: "retriever",
      detail: {
        chunks: [
          { id: "c1", score: 0.5, rankDense: 1 },
          { id: "x1", origin: "expansion" },
          { id: "x2", origin: "expansion" },
        ],
      },
    };
    const outcome = scoreQuestion(question, "… label-1 …", [scoped], {
      sourceTypeOf: (id) =>
        id === "c1" ? "source-a" : id.startsWith("x") ? "source-b" : undefined,
      expansionOrigin: "expansion",
    });
    expect(outcome.retrievalRecall).toBe(1);
    expect(outcome.expansion).toEqual({ chunks: 2, fusedOnlyRetrievalRecall: 0.5 });
  });

  it("keeps every expansion path out of the fused-only leg (A4 of the #274 fix round)", () => {
    // `retrievalRecall` reads every ref, so the two expansions' refs satisfy
    // the second expected source here. The fused-only leg must exclude BOTH:
    // it used to exclude only the scope origin, so the neighbour chunk counted
    // as fused, the metric equalled the reported recall, and the report could
    // no longer state that an expansion carried the question — the one
    // property #243 C1 exists for.
    const scoped: TraceEventLike = {
      kind: "retrieval",
      stage: "retriever",
      detail: {
        chunks: [
          { id: "c1", score: 0.5, rankDense: 1 },
          { id: "x1", origin: "expansion" },
          { id: "n1", origin: "verse_neighbours" },
        ],
      },
    };
    const outcome = scoreQuestion(question, "… label-1 …", [scoped], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      expansionOrigin: "expansion",
    });
    expect(outcome.retrievalRecall).toBe(1);
    // `chunks` counts the SCOPE path only (ADR-0045's published meaning), and
    // the fused-only leg is the one ref that carries no origin label.
    expect(outcome.expansion).toEqual({ chunks: 1, fusedOnlyRetrievalRecall: 0.5 });
  });

  it("records a recognised-but-empty scope honestly (0 chunks, fused-only = reported)", () => {
    const outcome = scoreQuestion(
      question,
      "… label-1 …",
      [
        { kind: "retrieval", stage: "retriever", detail: { chunks: [{ id: "c1" }] } },
        {
          kind: "scope_expansion",
          stage: "retriever",
          detail: { key: "reference", value: "1", returned: 0, cap: 12, truncated: false },
        },
      ],
      {
        sourceTypeOf: (id) => (id === "c1" ? "source-a" : undefined),
        expansionOrigin: "expansion",
      },
    );
    // The scoped read ran and added nothing: the report says so, and the
    // fused-only figure still exposes the missing second leg.
    expect(outcome.expansion).toEqual({ chunks: 0, fusedOnlyRetrievalRecall: 0.5 });
  });

  it("omits the expansion block when the scoped path did not run", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      expansionOrigin: "expansion",
    });
    expect(Object.hasOwn(outcome, "expansion")).toBe(false);
  });

  it("scores exactly as before when no origin label is injected", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
    });
    expect(outcome.retrievalRecall).toBe(1);
    expect(Object.hasOwn(outcome, "expansion")).toBe(false);
  });

  it("passes a correct refusal via trace event", () => {
    const refuseCase: GoldenQuestion = {
      ...question,
      expectedBehavior: "refuse",
      requiredCitations: [],
      expectedSourceTypes: [],
    };
    const outcome = scoreQuestion(
      refuseCase,
      "cannot answer",
      [{ kind: "refusal", stage: "generator" }],
      {
        sourceTypeOf: () => undefined,
      },
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.refused).toBe(true);
  });

  it("scores citation validity from the frame the transport carried", () => {
    // The answer text has no citation marker at all, but the server's frame
    // grounds it — exactly the live shape the raw-substring check mishandled.
    const outcome = scoreQuestion(
      question,
      "a grounded answer whose marker spelling differs",
      [retrievalEvent],
      { sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b") },
      { citations: [{ label: "label-1" }] },
    );
    expect(outcome.citationValidity).toBe(1);
    expect(outcome.passed).toBe(true);
  });

  it("still scores 0 when the frame does not ground the required citation", () => {
    const outcome = scoreQuestion(
      question,
      "label-1 in prose only",
      [retrievalEvent],
      {
        sourceTypeOf: () => "source-a",
      },
      { citations: [{ label: "some-other-label" }] },
    );
    expect(outcome.citationValidity).toBe(0);
    expect(outcome.passed).toBe(false);
  });
});

describe("Budget", () => {
  it("accumulates spend and reports the total", () => {
    const budget = new Budget(100);
    expect(budget.add(30)).toBe(30);
    expect(budget.add(30)).toBe(60);
    expect(budget.total).toBe(60);
  });

  it("throws when the cap is exceeded", () => {
    const budget = new Budget(100);
    budget.add(90);
    expect(() => budget.check(20)).toThrow(BudgetExceededError);
  });

  it("is unlimited without a cap", () => {
    const budget = new Budget(undefined);
    budget.add(10_000_000);
    expect(() => budget.check()).not.toThrow();
  });

  it("treats a zero cap as unlimited (explicit opt-out)", () => {
    const budget = new Budget(0);
    expect(() => budget.check(999_999_999)).not.toThrow();
  });
});

describe("budgetCapFromEnv", () => {
  it("parses an integer cap", () => {
    expect(budgetCapFromEnv("5000")).toBe(5000);
  });
  it("is undefined when unset (A1: an empty value now fails closed)", () => {
    expect(budgetCapFromEnv(undefined)).toBeUndefined();
  });
  it("throws fail-fast on an empty/whitespace value (thermo-review A1)", () => {
    expect(() => budgetCapFromEnv("")).toThrow(/set but empty/);
    expect(() => budgetCapFromEnv("   ")).toThrow(/set but empty/);
  });
  it("rejects non-integer or negative caps", () => {
    expect(() => budgetCapFromEnv("1.5")).toThrow();
    expect(() => budgetCapFromEnv("-1")).toThrow();
  });
});
