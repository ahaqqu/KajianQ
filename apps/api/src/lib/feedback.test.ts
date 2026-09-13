import { describe, expect, it, vi } from "vitest";
import type { Trace } from "@app/contracts";
import { deriveFeedbackCitations } from "./feedback";

/**
 * The feedback anchor derivation's degradation discrimination (thermo-review
 * A3): a missing answer text or a failed chunk lookup is a DEGRADED derivation
 * — a server-side condition the route answers 503 — never a malformed anchor,
 * and the caller's warn still sees the underlying failure. The successful
 * derivation is exercised end-to-end by the route tests; here only the
 * degradation paths and their discrimination.
 */

const TRACE: Trace = {
  id: "trace-1",
  createdAt: 1_700_000_000_000,
  events: [
    {
      stage: "retriever",
      kind: "retrieval",
      detail: { chunks: [{ id: "chunk-1", score: 0.5 }] },
      at: 1_700_000_000_100,
    },
  ],
};

describe("deriveFeedbackCitations degradation (A3)", () => {
  it("degrades with answer_text_missing when the answer text was reclaimed", async () => {
    const warn = vi.fn();
    const out = await deriveFeedbackCitations({
      messageId: "m1",
      trace: TRACE,
      answerText: null,
      fetchChunks: () => Promise.reject(new Error("must not be reached")),
      warn,
    });
    expect(out).toEqual({ degraded: true, reason: "answer_text_missing" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades with chunk_lookup_failed (and relays the warn) when the chunk fetch fails", async () => {
    const warn = vi.fn();
    const out = await deriveFeedbackCitations({
      messageId: "m1",
      trace: TRACE,
      answerText: "Allah Mahahidup [QS. 2:255].",
      fetchChunks: () => Promise.reject(new Error("store down")),
      warn,
    });
    expect(out).toEqual({ degraded: true, reason: "chunk_lookup_failed" });
    // Ops still sees why — the degrade-and-derive warning is relayed.
    expect(warn).toHaveBeenCalledWith(
      "feedback.anchor.chunk_lookup_failed",
      expect.objectContaining({ messageId: "m1", error: "store down" }),
    );
  });
});
