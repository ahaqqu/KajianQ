import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import {
  RunContext,
  toStageError,
  type AssembledContext,
  type Draft,
  type Reviewer,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { validateCitations } from "./chat-citation-validator";

/**
 * KajianQReviewer — stage 7 (spec §3.3): a cross-vendor LLM reviewer
 * (configured at wiring; this module never names one) plus the deterministic
 * citation validator. The reviewer's verdict and cost are recorded to the
 * run's trace sink; an ungrounded citation list appends a visible warning to
 * the answer (never silently dropped).
 */

export type ReviewerProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
};

export type KajianQReviewerDeps = {
  /** Null disables the LLM cross-check (deterministic validator still runs). */
  provider: ReviewerProvider | null;
  /** Skip the LLM call (refusal cases, cost-capped runs). */
  skipLlm?: boolean;
};

export function createKajianQReviewer(deps: KajianQReviewerDeps): Reviewer<KajianQFilters> {
  return {
    review: (draft: Draft, context: AssembledContext<KajianQFilters>) =>
      toStageError(
        "reviewer",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const { grounded, ungrounded } = validateCitations(draft.text, context.chunks);
          if (deps.provider === null || deps.skipLlm === true) {
            return warnIfUngrounded(draft, ungrounded);
          }
          const reply = yield* deps.provider
            .generate({
              turns: [
                {
                  role: "system",
                  content: [
                    "You are a faithfulness reviewer for a grounded Islamic knowledge answer.",
                    "Given the draft answer and the retrieved evidence, reply with ONLY JSON:",
                    '{"verdict": "pass" | "fail", "reason": "..."}',
                    "Fail when the answer claims something the evidence does not support,",
                    "or cites a source not present in the evidence.",
                  ].join("\n"),
                },
                {
                  role: "user",
                  content: [
                    "Evidence:",
                    ...context.chunks.map((c) => `- ${c.text}`),
                    "",
                    "Draft answer:",
                    draft.text,
                  ].join("\n"),
                },
              ],
            })
            .pipe(Effect.mapError((cause: unknown) => ({ cause })));
          run.record({
            stage: "reviewer",
            kind: "llm_call",
            detail: { purpose: "review" },
            cost: reply.cost,
            at: run.now(),
          });
          const verdict = parseReviewerVerdict(reply.text);
          run.record({
            stage: "reviewer",
            kind: "review",
            detail: { verdict: reply.text.slice(0, 200) },
            at: run.now(),
          });
          void grounded;
          // Thermo-review B5: the paid cross-vendor verdict actually gates —
          // a `fail` converts the answer to the grounding insufficiency
          // refusal (trace `refusal` event, recorded below via the
          // generator-side convention) instead of being recorded and then
          // discarded in favor of the deterministic warning alone.
          if (verdict === "fail") {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              reason: "reviewer: answer not supported by retrieved evidence",
              at: run.now(),
            });
            return {
              text: INSUFFICIENT_EVIDENCE_REFUSAL,
            };
          }
          return warnIfUngrounded(draft, ungrounded);
        }),
      ),
  };
}

/**
 * The reviewer's fail-verdict refusal text — the generator's ID/EN
 * insufficiency language so downstream refusal detection stays uniform.
 */
const INSUFFICIENT_EVIDENCE_REFUSAL = "tidak menemukan dalil yang memadai";

/**
 * Parse the reviewer LLM's `{"verdict": "pass" | "fail", ...}` reply
 * (thermo-review B5): unparseable output is treated as `pass` — the
 * deterministic citation validator still guards — never as silent approval
 * of a known-bad answer.
 */
export function parseReviewerVerdict(text: string): "pass" | "fail" {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown };
      if (parsed.verdict === "fail") return "fail";
      if (parsed.verdict === "pass") return "pass";
    } catch {
      // fall through to the default
    }
  }
  return /"verdict"\s*:\s*"fail"/.test(text) ? "fail" : "pass";
}

/** Surface ungrounded citations as a user-visible warning, never silently. */
function warnIfUngrounded(draft: Draft, ungrounded: string[]): Draft {
  if (ungrounded.length === 0) return draft;
  return {
    text: `${draft.text}\n\n[Peringatan] Sitasi tidak ditemukan dalam konteks: ${ungrounded.join(", ")}`,
  };
}
