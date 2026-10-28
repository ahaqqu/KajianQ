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

  it("renders no reviewer block for a frame whose trace recorded no decision", () => {
    renderTechnical(frame);

    expect(screen.queryByTestId("trace-reviewer")).toBeNull();
    expect(screen.queryByTestId("trace-reviewer-outcome")).toBeNull();
  });
});
