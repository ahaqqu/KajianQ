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
