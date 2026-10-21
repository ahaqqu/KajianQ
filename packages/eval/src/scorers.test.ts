import { describe, expect, it } from "vite-plus/test";
import { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
import {
  behaviorAccepted,
  citationAddressRecall,
  citationLabelsPresent,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  refusalCorrectness,
  sourceTypeRecall,
} from "./scorers";
import { scoreQuestion } from "./harness";
import type { GoldenQuestion } from "@app/contracts";
import type {
  CitationFrameLike,
  CitationGrammar,
  CitationIdentity,
  TraceEventLike,
} from "./harness-types";
import { CitationGrammarError } from "./citation-grammar";
import { CitationIdentityError } from "./citation-identity";

const question: GoldenQuestion = {
  id: "gs-test-1",
  question: "test question",
  language: "id",
  expectedSourceTypes: ["source-a", "source-b"],
  requiredCitations: ["label-1"],
  expectedBehavior: "answer",
};

describe("sourceTypeRecall", () => {
  it("scores 1 when every expected source type was retrieved", () => {
    const recall = sourceTypeRecall(["source-a", "source-b"], [{ id: "c1" }, { id: "c2" }], (id) =>
      id === "c1" ? "source-a" : "source-b",
    );
    expect(recall).toBe(1);
  });

  it("scores partially when only some expected types were retrieved", () => {
    const recall = sourceTypeRecall(["source-a", "source-b"], [{ id: "c1" }], () => "source-a");
    expect(recall).toBe(0.5);
  });

  it("scores 0 when nothing expected was retrieved", () => {
    const recall = sourceTypeRecall(["source-a"], [{ id: "c1" }], () => "source-c");
    expect(recall).toBe(0);
  });

  it("scores 1 for a question with no expected sources", () => {
    const recall = sourceTypeRecall([], [], () => undefined);
    expect(recall).toBe(1);
  });

  it("scores 1 for the right TYPE even when the required address is absent", () => {
    // The defect this metric cannot see: the fused set reached the right kind of
    // source and none of its labels is the address the fixture requires.
    expect(sourceTypeRecall(["source-a"], [{ id: "c1" }], () => "source-a")).toBe(1);
    expect(
      citationAddressRecall(["SRC. Alpha no. 1"], [{ id: "c1" }], () => "SRC. Alpha no. 2"),
    ).toBe(0);
  });
});

describe("citationAddressRecall", () => {
  const retrieved = (labels: (string | undefined)[]) =>
    labels.map((label, index) => ({ label, id: `c${index}` }));
  const citationOfFor = (labels: (string | undefined)[]) => (id: string) =>
    labels[Number(id.slice(1))];

  it("scores 1 when the required address is among the retrieved chunks", () => {
    const labels = ["SRC. Alpha no. 1"];
    expect(
      citationAddressRecall(["SRC. Alpha no. 1"], retrieved(labels), citationOfFor(labels)),
    ).toBe(1);
  });

  it("scores 0 for a neighbouring address of the same source type", () => {
    const labels = ["SRC. Alpha no. 2", "SRC. Alpha no. 3"];
    expect(
      citationAddressRecall(["SRC. Alpha no. 1"], retrieved(labels), citationOfFor(labels)),
    ).toBe(0);
  });

  it("requires every named citation — there is no any-of form", () => {
    const labels = ["SRC. Alpha no. 1"];
    expect(
      citationAddressRecall(
        ["SRC. Alpha no. 1", "SRC. Alpha no. 2"],
        retrieved(labels),
        citationOfFor(labels),
      ),
    ).toBe(0.5);
  });

  it("scores 1 when the question names no required citation", () => {
    expect(citationAddressRecall([], [], () => undefined)).toBe(1);
  });

  it("scores 0 when a retrieved chunk has no citation label at all", () => {
    expect(citationAddressRecall(["SRC. Alpha no. 1"], [{ id: "c1" }], () => undefined)).toBe(0);
  });

  it("uses the injected grammar's address list: a retrieved range names its whole interior", () => {
    const rangeGrammar = {
      normalizeLabel: (label: string) => label.trim(),
      labelsInText: () => [],
      addressesNamedBy: (label: string): readonly string[] => {
        const match = /^(Q\.?S\. \d+):(\d+)-(\d+)$/.exec(label);
        if (match === null) return [label];
        const out: string[] = [];
        for (let n = Number(match[2]); n <= Number(match[3]); n += 1) out.push(`${match[1]}:${n}`);
        return out;
      },
    };
    const labels = ["QS. 1:1-3"];
    expect(
      citationAddressRecall(["QS. 1:3"], retrieved(labels), citationOfFor(labels), rangeGrammar),
    ).toBe(1);
    expect(
      citationAddressRecall(["QS. 1:4"], retrieved(labels), citationOfFor(labels), rangeGrammar),
    ).toBe(0);
  });

  it("normalizes both sides through the grammar, so a grade suffix is not an address change", () => {
    const grammar = {
      normalizeLabel: (label: string) => label.replace(/\s+\([^)]*\)$/, ""),
      labelsInText: () => [],
      addressesNamedBy: (label: string): readonly string[] => [label],
    };
    const labels = ["SRC. Alpha no. 1 (Graded)"];
    expect(
      citationAddressRecall(
        ["SRC. Alpha no. 1"],
        retrieved(labels),
        citationOfFor(labels),
        grammar,
      ),
    ).toBe(1);
  });

  it("fails closed on a required label the grammar declares but cannot enumerate", () => {
    const unenumerable = {
      normalizeLabel: (label: string) => label,
      labelsInText: () => [],
      addressesNamedBy: (label: string): readonly string[] | null =>
        label.includes("-") ? null : [label],
    };
    const labels = ["SRC. Alpha no. 1-2"];
    expect(
      citationAddressRecall(
        ["SRC. Alpha no. 1-2"],
        retrieved(labels),
        citationOfFor(labels),
        unenumerable,
      ),
    ).toBe(0);
  });

  it("keeps an opaque label whole when the grammar names nothing for it", () => {
    const noGrammarMatch = {
      normalizeLabel: (label: string) => label,
      labelsInText: () => [],
      addressesNamedBy: (): readonly string[] => [],
    };
    const labels = ["an opaque chunk label"];
    expect(
      citationAddressRecall(
        ["an opaque chunk label"],
        retrieved(labels),
        citationOfFor(labels),
        noGrammarMatch,
      ),
    ).toBe(1);
  });

  it("compares exactly when no grammar is injected", () => {
    const labels = ["SRC. Alpha no. 1 (Graded)"];
    expect(
      citationAddressRecall(["SRC. Alpha no. 1"], retrieved(labels), citationOfFor(labels)),
    ).toBe(0);
    expect(
      citationAddressRecall(
        ["SRC. Alpha no. 1 (Graded)"],
        retrieved(labels),
        citationOfFor(labels),
      ),
    ).toBe(1);
  });

  it("refuses a grammar that cannot say what a label names, as a typed error", () => {
    // The production injector is JavaScript, so the declaration can be missing at
    // runtime: this is the shape a `.mjs` grammar loses by deleting one line. The
    // engine must fail typed from its own guard, not as a bare TypeError from the
    // metric's first call.
    const withoutDeclaration = {
      normalizeLabel: (label: string) => label,
      labelsInText: () => [],
    } as unknown as CitationGrammar;
    const call = (required: string[]) =>
      citationAddressRecall(required, [{ id: "c1" }], () => "SRC. Alpha no. 1", withoutDeclaration);
    expect(() => call(["SRC. Alpha no. 1"])).toThrow(CitationGrammarError);
    expect(() => call(["SRC. Alpha no. 1"])).toThrow(/addressesNamedBy/);
    // Guarded before the empty-required short-circuit, so no question escapes it.
    expect(() => call([])).toThrow(CitationGrammarError);
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

  /** The engine package must not depend on the domain pack, so the grammar is
   * faked; it canonicalizes marker spellings the way the real pair does. */
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
    // No list-valued citation form in this double: declared as identity, not omitted.
    addressesNamedBy: (label: string): readonly string[] => [label],
  };

  it("matches a marker-spelling variant the raw substring check misses", () => {
    // A marker variant (dotted `Q.S.` or dot-less `QS `) must match the fixture's spelling.
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
    // The fixture's own spelling may carry the variant; the grammar normalizes it.
    expect(citationValidity(["Q.S. 1:2"], "… QS. 1:2 …", { grammar })).toBe(1);
  });

  it("uses the citations frame when one is present, over the text", () => {
    // The frame is the server's grounded set; its labels win outright.
    const frame = { citations: [{ label: "QS. 1:2" }] };
    expect(citationValidity(["QS. 1:2"], "no citation in this text at all", { frame })).toBe(1);
  });

  it("NEVER scores a label the frame does not contain (ADR-0040 invariant)", () => {
    // A frame that grounds nothing cannot be talked into a pass by text that contains it.
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(citationValidity(["QS. 1:2"], "the text writes QS. 1:2 plainly", { frame })).toBe(0);
  });

  it("scores a hybrid refusal's frame on its citations, never on the refusal flag (#436)", () => {
    // A hybrid frame carries BOTH the grounded labels the text quotes and
    // `refusal: true`; the scorer reads the label list, never the flag.
    const hybridFrame = { refusal: true, citations: [{ label: "QS. 1:2" }] };
    expect(
      citationValidity(["QS. 1:2"], "… QS. 1:2 … lalu tidak menemukan dalil", {
        frame: hybridFrame,
      }),
    ).toBe(1);
    // A pure refusal's frame is genuinely empty, so its required citations stay absent.
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
    // A refusal records an empty `grounded` list; scoring must not fall through to the text.
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
   * The three evidence paths on a **grounded range**: the frame carries the
   * range as written while the required citation is a single verse, so both
   * sides are compared as the **sets of addresses they name**, through the same
   * declaration the gate grounds with.
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
    // The frame carries the range as written, backed by its head verse's row.
    const rangeFrame = { citations: [{ label: "QS. 2:255-256" }] };
    // The gate records every address the grounded range cites, head and tail.
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
      // The tail is never a literal substring, so the evidence names every address it cites.
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
      // A `null` declaration (a list the grammar cannot enumerate) is a REFUSAL,
      // not `[]` and not a one-element list: never read a shorter form of it.
      const unenumerable: CitationGrammar = {
        ...rangeGrammar,
        addressesNamedBy: (label: string): readonly string[] | null =>
          label.includes("-") ? null : [label],
      };
      // As EVIDENCE a `null` label names nothing verifiable, so it grounds nothing.
      const frame = { citations: [{ label: "QS. 2:255-256" }] };
      expect(citationValidity(["QS. 2:255"], answer, { frame, grammar: unenumerable })).toBe(0);
      // As a REQUIRED citation it is never present, even though the text contains its head.
      expect(
        citationValidity(["QS. 2:255-256"], answer, { frame: rangeFrame, grammar: unenumerable }),
      ).toBe(0);
      expect(citationValidity(["QS. 2:255-256"], answer, { grammar: unenumerable })).toBe(0);
      // `[]` is NOT `null`: a label the grammar cannot enumerate still compares whole.
      const namesNothing: CitationGrammar = { ...rangeGrammar, addressesNamedBy: () => [] };
      expect(
        citationValidity(["QS. 2:255-256"], answer, { frame: rangeFrame, grammar: namesNothing }),
      ).toBe(1);
    });

    it("keeps the frame authoritative: an empty frame is still 0", () => {
      // The frame stays authoritative: the relation reads its labels, it does not replace them.
      const empty = { citations: [] as { label: string }[] };
      expect(
        citationValidity(["QS. 2:255"], answer, { frame: empty, events, grammar: rangeGrammar }),
      ).toBe(0);
    });

    /** The declaration is required: its absence is a loud typed error at the
     * engine's grammar entry, never a silent string-only fallback. */
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
      // The grammar guard runs before the empty-required early return, so an
      // unwired grammar cannot hide behind a trap question.
      expect(() => citationValidity([], answer, { grammar: withoutDeclaration() })).toThrow(
        CitationGrammarError,
      );
    });
  });
});

describe("citationValidity — citation identity", () => {
  /** The engine must not import the domain pack, so the identity is faked:
   * one narration family, and `null` for everything the map does not carry. */
  const family: CitationIdentity = {
    identityOf: (label) =>
      label === "label-required" || label === "label-parallel" ? "family-1" : null,
  };
  const frameOf = (labels: string[]): CitationFrameLike => ({
    citations: labels.map((label) => ({ label })),
  });
  /** Each label names itself, so this block exercises the scorer's address
   * comparison rather than a grammar's parsing. */
  const labelAddresses: CitationGrammar = {
    normalizeLabel: (label) => label,
    labelsInText: () => [],
    addressesNamedBy: (label) => [label],
  };

  it("accepts a parallel narration of the required citation", () => {
    expect(
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-parallel"]),
        identity: family,
      }),
    ).toBe(1);
  });

  it("keeps the exact-row comparison when no identity is injected", () => {
    expect(
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-parallel"]),
      }),
    ).toBe(0);
  });

  it("keeps an unrelated citation invalid", () => {
    expect(
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-unrelated"]),
        identity: family,
      }),
    ).toBe(0);
  });

  it("keeps a required label the map cannot resolve unmatched", () => {
    expect(
      citationValidity(["label-unmapped"], "", {
        frame: frameOf(["label-parallel"]),
        identity: family,
      }),
    ).toBe(0);
  });

  it("keeps an unmapped required label's exact match when an identity is injected", () => {
    // The address comparison runs before the identity is consulted: the map's
    // silence about a label must not narrow it to a miss, or a required
    // citation the map does not cover scores 0 against its own evidence.
    expect(
      citationValidity(["label-unmapped"], "", {
        frame: frameOf(["label-unmapped"]),
        grammar: labelAddresses,
        identity: family,
      }),
    ).toBe(1);
    expect(
      citationValidity(["label-unmapped"], "", {
        frame: frameOf(["label-unrelated"]),
        grammar: labelAddresses,
        identity: family,
      }),
    ).toBe(0);
  });

  it("accepts a parallel narration through the trace's grounded labels", () => {
    expect(
      citationValidity(["label-required"], "", {
        events: [
          {
            kind: "review",
            stage: "reviewer",
            detail: { verdict: "{}", grounded: ["label-parallel"] },
          },
        ],
        identity: family,
      }),
    ).toBe(1);
  });

  it("accepts a parallel narration through the answer text's citation spans", () => {
    expect(
      citationValidity(["label-required"], "… label-parallel …", {
        grammar: {
          normalizeLabel: (label) => label,
          labelsInText: () => ["label-parallel"],
          addressesNamedBy: (label) => [label],
        },
        identity: family,
      }),
    ).toBe(1);
  });

  it("does not let an empty frame fall back to the text, even with an identity", () => {
    expect(
      citationValidity(["label-required"], "… label-parallel …", {
        frame: frameOf([]),
        identity: family,
      }),
    ).toBe(0);
  });

  it("fails loudly on a resolver that returns a non-string identity", () => {
    const malformed = { identityOf: () => undefined } as unknown as CitationIdentity;
    expect(() =>
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-parallel"]),
        identity: malformed,
      }),
    ).toThrow(CitationIdentityError);
    try {
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-parallel"]),
        identity: malformed,
      });
    } catch (error) {
      expect((error as CitationIdentityError).kind).toBe("citation_identity_malformed");
    }
  });

  it("fails loudly on a resolver whose identity is blank", () => {
    const blank = { identityOf: () => "" } as CitationIdentity;
    expect(() =>
      citationValidity(["label-required"], "", {
        frame: frameOf(["label-parallel"]),
        identity: blank,
      }),
    ).toThrow(CitationIdentityError);
  });

  it("fails loudly on a resolver with no identityOf, even with no required citations", () => {
    expect(() => citationValidity([], "", { identity: {} as unknown as CitationIdentity })).toThrow(
      CitationIdentityError,
    );
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
    // The fixture keeps the curated `QS. 1:2`; the grammar canonicalizes both sides.
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
    // Frame-first precedence: an empty frame is authoritative and the trace
    // labels are never consulted past it — a fabricated citation cannot pass.
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
    // A citation-shaped span in the prose is not evidence, so there is no text fallback.
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
    // A trap with no required citations or expected sources has this as its only live check.
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
  /** The retrieved chunks' citation labels: c1 carries the required label. */
  const citationOf = (id: string) => (id === "c1" ? "label-1" : undefined);
  const retrievalEvent: TraceEventLike = {
    kind: "retrieval",
    stage: "retriever",
    detail: { chunks: [{ id: "c1" }, { id: "c2" }] },
  };

  it("passes a fully correct answer", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.sourceTypeRecall).toBe(1);
    expect(outcome.citationValidity).toBe(1);
  });

  it("scores a parallel narration citation-valid, but not address-retrieved", () => {
    // The identity map lets the ANSWER cite the required narration through a
    // parallel chain; it does not make that chain the fixture's own address, so
    // retrieval never surfaced label-a and the question cannot pass on it.
    const outcome = scoreQuestion(
      { ...question, requiredCitations: ["label-a"] },
      "",
      [retrievalEvent],
      {
        sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
        citationOf,
        citationIdentity: {
          identityOf: (label) => (label === "label-a" || label === "label-b" ? "family-1" : null),
        },
      },
      { citations: [{ label: "label-b" }] },
    );
    expect(outcome.citationValidity).toBe(1);
    expect(outcome.citationAddressRecall).toBe(0);
    expect(outcome.sourceTypeRecall).toBe(1);
    expect(outcome.passed).toBe(false);
  });

  it("separates type recall from address recall on a neighbour-only fused set", () => {
    // Falsification: the fixture's required address is replaced by its neighbour
    // in the fused set, then the address-bearing ref is dropped altogether. The
    // source type stays reached throughout; the address score moves 1 -> 0.
    const exact = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf: (id) => (id === "c1" ? "label-1" : undefined),
    });
    expect(exact.sourceTypeRecall).toBe(1);
    expect(exact.citationAddressRecall).toBe(1);
    expect(exact.passed).toBe(true);

    const neighbour = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf: (id) => (id === "c2" ? "label-2" : undefined),
    });
    expect(neighbour.sourceTypeRecall).toBe(1);
    expect(neighbour.citationAddressRecall).toBe(0);
    expect(neighbour.passed).toBe(false);

    // Drop the address-bearing chunk: the same types are still reached by two
    // neighbouring chunks, so only the address dimension moves.
    const droppedEvent: TraceEventLike = {
      kind: "retrieval",
      stage: "retriever",
      detail: { chunks: [{ id: "c2" }, { id: "c3" }] },
    };
    const dropped = scoreQuestion(question, "… label-1 …", [droppedEvent], {
      sourceTypeOf: (id) => (id === "c2" ? "source-a" : "source-b"),
      citationOf: (id) => (id === "c2" ? "label-2" : "label-3"),
    });
    expect(dropped.sourceTypeRecall).toBe(1);
    expect(dropped.citationAddressRecall).toBe(0);
    expect(dropped.passed).toBe(false);
  });

  it("reports an address miss without gating it when the run turns the gate off", () => {
    // The deployed smoke's policy: the address dimension is still measured and
    // persisted, but it does not decide `passed` — the eval gate keeps it on.
    const neighbourEvent: TraceEventLike = {
      kind: "retrieval",
      stage: "retriever",
      detail: { chunks: [{ id: "c2" }, { id: "c3" }] },
    };
    const deps = {
      sourceTypeOf: (id: string) => (id === "c2" ? "source-a" : "source-b"),
      citationOf: (id: string) => (id === "c2" ? "label-2" : "label-3"),
    };
    const gated = scoreQuestion(question, "… label-1 …", [neighbourEvent], deps);
    expect(gated.sourceTypeRecall).toBe(1);
    expect(gated.citationValidity).toBe(1);
    expect(gated.citationAddressRecall).toBe(0);
    expect(gated.passed).toBe(false);
    const reported = scoreQuestion(question, "… label-1 …", [neighbourEvent], {
      ...deps,
      gateAddressRecall: false,
    });
    expect(reported.citationAddressRecall).toBe(0);
    expect(reported.passed).toBe(true);
  });

  it("fails when the required citation is missing", () => {
    const outcome = scoreQuestion(question, "no citation here", [retrievalEvent], {
      sourceTypeOf: () => "source-a",
      citationOf,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.citationValidity).toBe(0);
  });

  it("scores recall 0 when no retrieval event exists in the trace", () => {
    const outcome = scoreQuestion(question, "label-1", [], {
      sourceTypeOf: () => undefined,
      citationOf,
    });
    expect(outcome.sourceTypeRecall).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it("records the expansion's contribution beside the unchanged metric (C1)", () => {
    // `sourceTypeRecall` reads every ref regardless of origin, so the expansion
    // refs satisfy the expected source; the outcome must still say WHICH path.
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
      citationOf,
      expansionOrigin: "expansion",
    });
    expect(outcome.sourceTypeRecall).toBe(1);
    expect(outcome.expansion).toEqual({ chunks: 2, fusedOnlySourceTypeRecall: 0.5 });
  });

  it("keeps every deterministic path out of the fused-only leg (A4 of the #274 fix round)", () => {
    // The fused-only leg must exclude every labelled ref: excluding only the scope
    // origin would count a neighbour or label-lookup chunk as fused and equal the
    // reported recall.
    const scoped: TraceEventLike = {
      kind: "retrieval",
      stage: "retriever",
      detail: {
        chunks: [
          { id: "c1", score: 0.5, rankDense: 1 },
          { id: "x1", origin: "expansion" },
          { id: "n1", origin: "verse_neighbours" },
          { id: "l1", origin: "citation_lookup" },
        ],
      },
    };
    const outcome = scoreQuestion(question, "… label-1 …", [scoped], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf,
      expansionOrigin: "expansion",
    });
    expect(outcome.sourceTypeRecall).toBe(1);
    // `chunks` counts the SCOPE path only; the fused-only leg is the ref with no origin label.
    expect(outcome.expansion).toEqual({ chunks: 1, fusedOnlySourceTypeRecall: 0.5 });
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
        citationOf,
        expansionOrigin: "expansion",
      },
    );
    // The scoped read ran and added nothing: the report says so beside the fused-only figure.
    expect(outcome.expansion).toEqual({ chunks: 0, fusedOnlySourceTypeRecall: 0.5 });
  });

  it("omits the expansion block when the scoped path did not run", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf,
      expansionOrigin: "expansion",
    });
    expect(Object.hasOwn(outcome, "expansion")).toBe(false);
  });

  it("scores exactly as before when no origin label is injected", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
      citationOf,
    });
    expect(outcome.sourceTypeRecall).toBe(1);
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
        citationOf,
      },
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.refused).toBe(true);
  });

  it("scores citation validity from the frame the transport carried", () => {
    // The answer text has no citation marker at all; the server's frame grounds it.
    const outcome = scoreQuestion(
      question,
      "a grounded answer whose marker spelling differs",
      [retrievalEvent],
      { sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"), citationOf },
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
        citationOf,
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
