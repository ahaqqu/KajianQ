import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  type AssembledContext,
  type CostRecord,
  type Draft,
  type Reviewer,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { validateCitations } from "./chat-citation-validator";
import { applyProductRules } from "./chat-postprocess";

/**
 * KajianQReviewer — stage 7 (spec §3.3): a cross-vendor LLM reviewer
 * (configured at wiring; this module never names one) plus the deterministic
 * citation validator. The reviewer's verdict and cost are recorded to the
 * run's trace sink.
 *
 * **The trust invariant (ticket #10):** an answer carrying a citation that no
 * retrieved chunk grounds is *refused*, never delivered with a note. The
 * deterministic validator runs on 100% of answers and its verdict is final —
 * it does not depend on the reviewer LLM being configured, reachable, or
 * well-behaved. A fabricated citation is the product's #1 stated risk
 * (SPECS §2.2), and a warning appended to a fabricated answer still ships the
 * fabrication to the user.
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
  /** Refusal text for the active answer language. */
  refusalText?: (reason: "ungrounded" | "reviewer") => string;
  /** Answer language — drives the deterministic post-processing text. */
  language?: import("./chat-prompts").ChatLanguage;
  /**
   * Apply the deterministic product rules (dhaif warning, machine-translation
   * label, ulama disclaimer) to a passed draft. Default on; a test or an eval
   * refusal case can disable it.
   */
  applyProductRules?: boolean;
};

/**
 * The default refusal language (the generator's ID/EN insufficiency text).
 * `chat-prompts.ts` imports this to instruct the generator to emit it verbatim —
 * the detector matches these exact strings, so the copy and the instruction must
 * not drift.
 */
export const DEFAULT_REFUSALS = {
  id: "tidak menemukan dalil yang memadai",
  en: "could not find adequate evidence",
} as const;

/** The refusal text a language resolves to (kept next to the prompts). */
export function refusalTextFor(
  language: import("./chat-prompts").ChatLanguage,
  reason: "ungrounded" | "reviewer",
): string {
  if (reason === "reviewer") {
    return language === "en"
      ? "the answer was not supported by the retrieved evidence"
      : "jawaban tidak didukung oleh dalil yang ditemukan";
  }
  return language === "en" ? DEFAULT_REFUSALS.en : DEFAULT_REFUSALS.id;
}

export function createKajianQReviewer(deps: KajianQReviewerDeps): Reviewer<KajianQFilters> {
  const refusal = deps.refusalText ?? ((reason) => refusalTextFor("id", reason));
  return {
    review: (draft: Draft, context: AssembledContext<KajianQFilters>) =>
      toStageError(
        "reviewer",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const { grounded, ungrounded } = validateCitations(draft.text, context.chunks);

          // The deterministic gate first, and unconditionally: a fabricated
          // citation is refused whether or not the reviewer LLM is wired.
          // Recorded as a `refusal` event so the trace (and the eval harness's
          // refusal detection) shows why the user got a refusal.
          if (ungrounded.length > 0) {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              detail: { trigger: "ungrounded_citation" },
              reason: `citation(s) not present in retrieved context: ${ungrounded.join(", ")}`,
              at: run.now(),
            });
            return { text: refusal("ungrounded") };
          }

          if (deps.provider === null || deps.skipLlm === true) {
            return withRules(draft, context);
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
          const parsedVerdict = parseReviewerVerdict(reply.text);
          const verdict = parsedVerdict.verdict;
          run.record({
            stage: "reviewer",
            kind: "review",
            detail: {
              verdict: reply.text.slice(0, 200),
              // B4: the deterministic gate's pass case is provenance too.
              grounded,
              // A3: an unreadable verdict is recorded as such — an operator
              // (or the eval harness) can tell "reviewer passed" from
              // "reviewer output was unusable" without reading the raw text.
              ...(parsedVerdict.parseFailed ? { verdictParseFailed: true } : {}),
            },
            at: run.now(),
          });
          // Thermo-review B5: the paid cross-vendor verdict actually gates —
          // a `fail` converts the answer to the grounding insufficiency
          // refusal instead of being recorded and then discarded.
          if (verdict === "fail") {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              reason: "reviewer: answer not supported by retrieved evidence",
              at: run.now(),
            });
            return { text: refusal("reviewer") };
          }
          return withRules(draft, context);
        }),
      ),
  };

  /**
   * The deterministic product rules (spec §2.2, ticket #10): a passed draft
   * gains the dhaif warning, the machine-translation label, and the ulama
   * disclaimer when the model omitted them. Never applied to a refusal — the
   * refusal is the honest answer, and decorating it would bury the reason.
   */
  function withRules(draft: Draft, context: AssembledContext<KajianQFilters>): Draft {
    if (deps.applyProductRules === false) return draft;
    return applyProductRules(draft, context, deps.language ?? "id").draft;
  }
}

/**
 * The reviewer LLM's parsed verdict, with the distinction the trace needs
 * (thermo-review A3).
 *
 * `verdict` stays `pass` when the reply carried no readable verdict — the
 * deterministic citation validator already ran and its verdict was final, and
 * failing closed here would turn a vendor rate-limit message or a truncated
 * envelope into a user-visible refusal. But `parseFailed` marks that case, so
 * the review event records `verdictParseFailed: true` and an operator (or the
 * eval harness) can count indeterminate reviews instead of reading them as
 * genuine passes.
 */
export type ReviewerVerdict = {
  verdict: "pass" | "fail";
  /** True when no explicit `pass`/`fail` signal could be read from the reply. */
  parseFailed: boolean;
};

export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown };
      if (parsed.verdict === "fail") return { verdict: "fail", parseFailed: false };
      if (parsed.verdict === "pass") return { verdict: "pass", parseFailed: false };
    } catch {
      // fall through to the raw-text scan
    }
  }
  if (/"verdict"\s*:\s*"fail"/.test(text)) return { verdict: "fail", parseFailed: false };
  if (/"verdict"\s*:\s*"pass"/.test(text)) return { verdict: "pass", parseFailed: false };
  // No readable verdict: not a pass we can attest to — an indeterminate one.
  return { verdict: "pass", parseFailed: true };
}
