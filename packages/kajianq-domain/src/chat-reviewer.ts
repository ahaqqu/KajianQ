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

/**
 * True when the draft IS the canonical insufficiency refusal the generator was
 * instructed to emit verbatim (`chat-prompts.ts`). Both language markers are
 * detected: the model may answer in the wrong language, and a refusal in
 * either is still a refusal.
 */
export function isRefusalDraft(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes(DEFAULT_REFUSALS.id) || t.includes(DEFAULT_REFUSALS.en);
}

/**
 * The reviewer's system prompt: the grounding rules for the cross-vendor gate.
 * Exported with `buildReviewMessages` so a test or an offline probe exercises
 * the exact prompt production sends.
 */
export const REVIEWER_SYSTEM_PROMPT = [
  "You are a faithfulness reviewer for a grounded Islamic knowledge answer.",
  "Given the question, the draft answer, and the retrieved evidence, reply with ONLY JSON:",
  '{"verdict": "pass" | "fail", "reason": "..."}',
  "The evidence is the exact context the answer was given: each block is the Arabic",
  "original, the machine-translation label, the translation where the source has it,",
  "and the block's own citation label.",
  "Translating a quoted passage into the answer's language, quoting it, and naming the",
  "citation labels the evidence itself carries are REQUIRED of the answer and are never",
  "grounds for failure: a label that appears in the evidence is supported by definition,",
  "and a translation of a quoted passage is not a new claim.",
  "The question is the user's own wording. Using a term the QUESTION itself uses for a",
  "passage the evidence contains (for example, presenting a retrieved verse as the one",
  "the question names) is not an unsupported claim.",
  "Fail ONLY when the answer asserts something the evidence does not support, contradicts",
  "the evidence, or cites a source absent from the evidence.",
].join("\n");

/**
 * The reviewer's evidence + draft turns. The evidence is the assembler's own
 * context turn — the exact text the Generator was asked to answer from — so
 * the gate cannot fail an answer for quoting what the prompt actually
 * provided. It used to re-render `- ${chunk.text}`, which for a fallback-track
 * hit is the translation only: the Generator saw the Arabic layer and the
 * Reviewer rejected answers that quoted it as "absent from the evidence".
 *
 * The question rides along so the gate can tell the user's own term (a name
 * the answer is entitled to reuse) from a claim the evidence does not carry.
 *
 * Using the assembled turn (rather than re-rendering the chunks) makes the
 * parity structural: one source of truth, and history rides its own turn, so
 * the last user turn is the evidence.
 */
export function buildReviewMessages(
  context: AssembledContext<KajianQFilters>,
  draftText: string,
): { role: string; content: string }[] {
  const evidence = context.turns.filter((turn) => turn.role === "user").at(-1)?.content ?? "";
  return [
    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Question: ${context.query.intent}`,
        "",
        "Evidence:",
        evidence,
        "",
        "Draft answer:",
        draftText,
      ].join("\n"),
    },
  ];
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

          // A generator-emitted refusal IS the refusal (round-3 A2): it must
          // not pay a reviewer LLM call, must not gain the product rules (a
          // disclaimer appended to a refusal buries the reason), and must be
          // visible on the trace as a `refusal` event — the same signal the
          // eval harness's refusal detection reads.
          if (isRefusalDraft(draft.text)) {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              detail: { trigger: "generator_refusal" },
              reason: "generator emitted the canonical insufficiency refusal",
              at: run.now(),
            });
            return { text: draft.text };
          }

          if (deps.provider === null || deps.skipLlm === true) {
            return withRules(draft, context);
          }
          const reply = yield* deps.provider
            .generate({ turns: buildReviewMessages(context, draft.text) })
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
              // The reviewer's full reply, not a prefix: truncating it at 200
              // chars cut every rejection reason mid-sentence, which is exactly
              // the text an operator needs to judge whether a refusal was
              // correct (the first live size-5 smoke could only be diagnosed
              // from partial sentences).
              verdict: reply.text,
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
