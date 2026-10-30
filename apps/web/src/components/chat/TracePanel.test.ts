// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatTraceFrame } from "@app/contracts";
import { LocaleCtx } from "../../lib/i18n";
import { TracePanel } from "./TracePanel";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

/** The reranked order, with the fused score deliberately reversing it. */
const frame: ChatTraceFrame = {
  messageId: "m1",
  sources: [
    { id: "c2", source: "Al-Muwatta" },
    { id: "c1", source: "Al-Baqarah" },
  ],
  technical: {
    subQueries: [],
    models: ["jev-1.13.0"],
    chunks: [
      { id: "c2", source: "Al-Muwatta", score: 0.031, rerankScore: 0.71 },
      { id: "c1", source: "Al-Baqarah", score: 0.03, rerankScore: 0.08 },
    ],
  },
};

function renderTechnical(trace: ChatTraceFrame | undefined) {
  render(
    createElement(
      LocaleCtx.Provider,
      { value: "id" },
      createElement(TracePanel, { trace, messageId: "m1", persisted: false }),
    ),
  );
  fireEvent.click(screen.getByTestId("trace-toggle"));
  fireEvent.click(screen.getByTestId("trace-tech-toggle"));
}

const texts = (testId: string): (string | null)[] =>
  screen.queryAllByTestId(testId).map((node) => node.textContent);

describe("TracePanel — the scores explain the order they render", () => {
  it("renders the rerank score beside the fused score, in list order (A5)", () => {
    renderTechnical(frame);

    expect(texts("trace-score")).toEqual(["skor fusi 0,031", "skor fusi 0,03"]);
    // The list is reranked: c2 (fused 0.031) leads c1 (fused 0.03) only
    // because the decision model scored it higher.
    expect(texts("trace-rerank-score")).toEqual(["skor rerank 0,71", "skor rerank 0,08"]);
  });

  it("renders no rerank score for a frame a pre-rerank trace produced", () => {
    const old: ChatTraceFrame = {
      messageId: "m1",
      sources: [{ id: "c1", source: "Al-Baqarah" }],
      technical: {
        subQueries: [],
        models: [],
        chunks: [{ id: "c1", source: "Al-Baqarah", score: 0.03 }],
      },
    };
    renderTechnical(old);

    expect(texts("trace-score")).toEqual(["skor fusi 0,03"]);
    expect(texts("trace-rerank-score")).toEqual([]);
  });
});

/**
 * The reviewer pre-gate's verdict (ADR-0042) renders as its own block in the
 * technical layer: which way the screening call decided, why it escalated, the
 * threshold it decided against, and the per-citation scores. A citation the
 * pre-gate could not judge reads "not judged" — never a score, never a zero.
 */
describe("TracePanel — the reviewer pre-gate's verdict", () => {
  const withReviewer = (reviewer: NonNullable<ChatTraceFrame["technical"]["reviewer"]>) =>
    ({ ...frame, technical: { ...frame.technical, reviewer } }) satisfies ChatTraceFrame;

  it("renders a skip: the clear, the threshold, and every citation's score", () => {
    renderTechnical(
      withReviewer({
        outcome: "skip",
        threshold: 0.5,
        items: [
          { index: 0, key: "QS. 2:255", score: 0.93 },
          { index: 1, key: "HR. Malik no. 18", score: 0.61 },
        ],
      }),
    );

    expect(screen.getByTestId("trace-reviewer")).toBeTruthy();
    expect(texts("trace-reviewer-outcome")).toEqual(["Lolos — reviewer dilewati"]);
    // A skip carries no reason: the clear is the whole verdict.
    expect(screen.queryByTestId("trace-reviewer-reason")).toBeNull();
    expect(texts("trace-reviewer-threshold")).toEqual(["0,5"]);
    expect(texts("trace-reviewer-item")).toEqual([
      "01QS. 2:255skor dukungan 0,93",
      "02HR. Malik no. 18skor dukungan 0,61",
    ]);
  });

  it("renders an escalate with its reason and leaves an unjudged citation unscored", () => {
    renderTechnical(
      withReviewer({
        outcome: "escalate",
        reason: "below_threshold",
        threshold: 0.5,
        items: [
          { index: 0, key: "QS. 2:255", score: 0.31 },
          { index: 1, key: "HR. Malik no. 18" },
        ],
      }),
    );

    expect(texts("trace-reviewer-outcome")).toEqual(["Diteruskan ke reviewer"]);
    expect(texts("trace-reviewer-reason")).toEqual(["Ada sitasi di bawah ambang skor"]);
    expect(texts("trace-reviewer-score")).toEqual(["skor dukungan 0,31"]);
    // "Not judged" is the absence of a score, never a zero.
    expect(texts("trace-reviewer-unscored")).toEqual(["tidak dinilai"]);
  });

  it("renders an unknown reason verbatim, never an empty line", () => {
    renderTechnical(
      withReviewer({
        outcome: "escalate",
        reason: "future_reason",
        threshold: 0.5,
        items: [],
      }),
    );

    // The reason is an opaque string in the frame: a value this copy has not
    // learned yet must reach the reader, not resolve to a missing message key.
    expect(texts("trace-reviewer-reason")).toEqual(["future_reason"]);
  });

  it("renders a reason naming an inherited object property verbatim", () => {
    // The lookup must not read the prototype chain: these three strings are
    // truthy on a plain object literal, so an object-keyed copy map would render
    // an empty reason line instead of the value the trace carried.
    for (const reason of ["constructor", "toString", "__proto__"]) {
      cleanup();
      renderTechnical(withReviewer({ outcome: "escalate", reason, threshold: 0.5, items: [] }));
      expect(texts("trace-reviewer-reason")).toEqual([reason]);
    }
  });

  it("renders the verdict without a threshold row when the frame carries none", () => {
    renderTechnical(withReviewer({ outcome: "escalate", reason: "no_items", items: [] }));

    // A decision the event recorded without its number is still shown: the
    // verdict is the point, the threshold row is omitted rather than fabricated.
    expect(texts("trace-reviewer-outcome")).toEqual(["Diteruskan ke reviewer"]);
    expect(texts("trace-reviewer-reason")).toEqual(["Tidak ada sitasi untuk dinilai"]);
    expect(screen.queryByTestId("trace-reviewer-threshold")).toBeNull();
  });

  it("renders no reviewer block for a frame whose trace recorded no decision", () => {
    renderTechnical(frame);

    expect(screen.queryByTestId("trace-reviewer")).toBeNull();
    expect(screen.queryByTestId("trace-reviewer-outcome")).toBeNull();
  });
});

/**
 * The chains consulted (spec §9.5): the panel names every transmission row the run
 * read for the passages in context, in the server-derived order, with each row's
 * grade, its grader and its Arabic sanad. A frame whose run recorded no read omits
 * the block; a run that read and found none says so — the two facts stay distinct.
 */
describe("TracePanel — the transmission chains consulted", () => {
  const withChains = (chains: NonNullable<ChatTraceFrame["technical"]["chains"]>) =>
    ({ ...frame, technical: { ...frame.technical, chains } }) satisfies ChatTraceFrame;

  it("renders every row of every consulted passage with grade, grader and sanad", () => {
    renderTechnical(
      withChains([
        {
          childId: "c2",
          chains: [
            {
              narrators: [
                { id: "n1", nameAr: "نافع" },
                { id: "n2", nameAr: "ابن عمر" },
              ],
              grade: "sahih",
              grader: "al-bukhari",
            },
            {
              narrators: [{ id: "n1", nameAr: "نافع" }],
              grade: "dhaif",
              grader: "al-daraqutni",
              moreMayExist: true,
            },
          ],
        },
      ]),
    );

    const rows = texts("trace-chain-row");
    expect(rows).toHaveLength(2);
    // Every row renders its own grade, grader and sanad — the weaker row is not
    // hidden behind the stronger one.
    expect(rows[0]).toContain("sahih");
    expect(rows[0]).toContain("penilai: al-bukhari");
    expect(rows[0]).toContain("ابن عمر");
    expect(rows[1]).toContain("dhaif");
    expect(rows[1]).toContain("penilai: al-daraqutni");
    expect(texts("trace-chain-child")[0]).toContain("c2");
  });

  it("says a read found no row when the record is empty", () => {
    renderTechnical(withChains([]));
    expect(screen.getByTestId("trace-chains")).toBeTruthy();
    expect(texts("trace-no-chains")).toEqual(["Tidak ada sanad yang tercatat untuk jawaban ini."]);
  });

  it("omits the block entirely when the run recorded no read", () => {
    renderTechnical(frame);
    expect(screen.queryByTestId("trace-chains")).toBeNull();
  });
});
