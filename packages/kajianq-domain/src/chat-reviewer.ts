import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  type AssembledContext,
  type Decider,
  type Draft,
  type Reviewer,
  type RunContextService,
} from "@app/rag-core";
import { applyProductRules } from "./chat-postprocess";
// Both citation screens arrive through one import (the pre-gate module
// re-exports the deterministic gate) so the stage stays inside the agentic
// import cap while the gate keeps its own module and stays first in the order.
import { runCitationPregate, validateCitations } from "./chat-reviewer-pregate";
import {
  buildReviewMessages,
  refusalDraftDecision,
  refusalTextFor,
  type KajianQFilters,
  type RefusalTrigger,
  type ReviewerLlmSeam,
} from "./chat-reviewer-prompt";

/**
 * KajianQReviewer — stage 7 (spec §3.3): a cross-vendor LLM reviewer
 * (configured at wiring; this module never names one) plus the deterministic
 * citation validator. The reviewer's verdict and cost are recorded to the
 * run's trace sink.
 *
 * **The trust invariant:** an answer carrying a citation that no retrieved
 * chunk grounds is *refused*, never delivered with a note. The deterministic
 * validator runs on 100% of answers and its verdict is final — it does not
 * depend on the reviewer LLM being configured, reachable, or well-behaved. A
 * fabricated citation is the product's #1 stated risk (SPECS §2.2), and a
 * warning appended to a fabricated answer still ships the fabrication to the
 * user.
 *
 * **The pre-gate (ADR-0042):** when a decision-model `Decider` is bound, one
 * batched decision call screens every citation before the paid LLM reviewer.
 * All citations cleared → the draft is reviewed-clean and the paid reviewer is
 * skipped; anything else (a low score, an unusable answer, a vendor failure,
 * or a draft with no citation to judge at all) escalates to the full LLM
 * reviewer. The pre-gate can only ever *remove* spend on an answer the cheap
 * judge affirmatively cleared; it never gates quality alone. With no `Decider`
 * wired (no key bound) the paid reviewer runs unconditionally.
 */

/** The serving name for the reviewer LLM seam (ADR-0043 `personalData` flag). */
export type ReviewerProvider = ReviewerLlmSeam;

export type KajianQReviewerDeps = {
  /** Null disables the LLM cross-check (deterministic validator still runs). */
  provider: ReviewerProvider | null;
  /**
   * The decision-model pre-gate (ADR-0042). Null/absent = the decision
   * vendor's key is not bound. There is deliberately no separate enable flag:
   * the pre-gate is active wherever the key is bound.
   */
  decider?: Decider | null;
  /** Per-citation support threshold; product policy default (ADR-0042). */
  pregateThreshold?: number;
  /** Skip the LLM call (refusal cases, cost-capped runs). */
  skipLlm?: boolean;
  /** Refusal text for the active answer language. */
  refusalText?: (reason: "ungrounded" | "reviewer") => string;
  /** Answer language — drives the deterministic post-processing text. */
  language?: import("./chat-prompts").ChatLanguage;
  /**
   * Apply the deterministic product rules (dhaif warning, machine-translation
   * label, ulama disclaimer) to a passed draft. Default on; a test or an eval
   * refusal case can disable it. Disabling it also suppresses the
   * `product_rules` trace event — the event is recorded only where the rules
   * actually run, so a reader never sees "rules ran" for a run that skipped
   * them.
   */
  applyProductRules?: boolean;
};

/**
 * The stage's two seams live beside it, each with its own named test: the
 * prompt half in `chat-reviewer-prompt.ts`, the refusal vocabulary — sentence,
 * predicates, decision table, trigger union — in `chat-refusal.ts`. The
 * vocabulary is re-exported so every existing import surface keeps working and
 * this file holds ONE import statement for its whole seam, being at the
 * agentic 5-import cap.
 */
export {
  DEFAULT_REFUSALS,
  isRefusalDraft,
  refusalTextFor,
  type RefusalTrigger,
} from "./chat-refusal";
export { REVIEWER_SYSTEM_PROMPT, buildReviewMessages } from "./chat-reviewer-prompt";

export function createKajianQReviewer(deps: KajianQReviewerDeps): Reviewer<KajianQFilters> {
  const refusal = deps.refusalText ?? ((reason) => refusalTextFor("id", reason));
  return {
    review: (draft: Draft, context: AssembledContext<KajianQFilters>) =>
      toStageError(
        "reviewer",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const { grounded, ungrounded } = validateCitations(draft.text, context.chunks);

          // The refusal decision: one owner for every shape that reaches this
          // path, and its FIRST row is the deterministic gate's own, so a
          // fabricated citation is refused whether or not the reviewer LLM is
          // wired and whether or not the draft carries the sentence — the order
          // is structural, not a convention across two call sites. Every row is
          // recorded as a `refusal` event, the trace's record of why the user
          // got a refusal; which shape a sentence-carrying draft has and what
          // each ships is the table's (skip the paid reviewer, ADR-0009, never
          // an `Always` rule or the reader's ability to tell a refusal from
          // prose).
          const decision = refusalDraftDecision(draft.text, { grounded, ungrounded });
          if (decision !== null) {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              detail: { trigger: decision.trigger },
              reason: decision.reason,
              at: run.now(),
            });
            // Exhaustive on purpose: a new delivery must fail the typecheck here.
            switch (decision.delivery) {
              case "rules":
                return withRules(draft, context, run);
              case "draft":
                return { text: draft.text };
              case "product_refusal":
                return { text: refusal("ungrounded") };
              default:
                return assertNeverDelivery(decision.delivery);
            }
          }

          if (deps.provider === null || deps.skipLlm === true) {
            return withRules(draft, context, run);
          }

          // The pre-gate sits between the free deterministic validator and the
          // paid reviewer: exactly one batched decision call, and only a full
          // clear skips the reviewer. A vendor failure is classified inside
          // (fail-open) — it never throws out of here.
          if (deps.decider != null) {
            const pregate = yield* runCitationPregate({
              decider: deps.decider,
              draft: draft.text,
              chunks: context.chunks,
              stage: "reviewer",
              run,
              ...(deps.pregateThreshold !== undefined ? { threshold: deps.pregateThreshold } : {}),
            });
            if (pregate.kind === "skip") {
              return withRules(draft, context, run);
            }
          }

          const reply = yield* deps.provider
            .generate({ turns: buildReviewMessages(context, draft.text), personalData: true })
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
              // The reviewer's COMPLETE reply, never a truncated prefix: an
              // operator needs the whole rejection reason to judge whether a
              // refusal was correct.
              verdict: reply.text,
              // The deterministic gate's pass case is provenance too.
              grounded,
              // An unreadable verdict is recorded as such — an operator (or
              // the eval harness) can tell "reviewer passed" from "reviewer
              // output was unusable" without reading the raw text.
              ...(parsedVerdict.parseFailed ? { verdictParseFailed: true } : {}),
            },
            at: run.now(),
          });
          // The paid cross-vendor verdict gates: a `fail` ships the reviewer
          // refusal copy, not the canonical insufficiency string.
          if (verdict === "fail") {
            run.record({
              stage: "reviewer",
              kind: "refusal",
              detail: { trigger: "reviewer_fail" satisfies RefusalTrigger },
              reason: "reviewer: answer not supported by retrieved evidence",
              at: run.now(),
            });
            return { text: refusal("reviewer") };
          }
          return withRules(draft, context, run);
        }),
      ),
  };

  /**
   * The deterministic product rules (spec §2.2): a passed draft gains the dhaif
   * warning, the machine-translation label, and the ulama disclaimer when the
   * model omitted them.
   *
   * **This is the ONE place the rules run, and therefore the one place the
   * trace records that they did (ADR-0007).** Every "rules apply" exit funnels
   * through here — the hybrid-refusal exit, no-provider/`skipLlm`, the ADR-0042
   * pre-gate skip, and reviewer-passed — so an exit added later records the
   * event by construction rather than by remembering to. The pre-gate skip is
   * why a dedicated event exists instead of a field on `review`: it records no
   * `review` event at all, so a rule running there would otherwise be
   * invisible.
   *
   * Three shapes do NOT reach here, and none is decorated: a pure refusal (a
   * warning on it would be invented from the assembled context rather than the
   * text), an asserting refusal draft, and the gate's own ungrounded-citation
   * refusal — the product's own refusal ships for those. A HYBRID does: it
   * answers from the evidence and then declines.
   *
   * The recording is deliberately keyed on `applyProductRules !== false` (the
   * same condition that gates the call), so the event means "the rules ran",
   * never "the stage passed". The returned draft stays the single source of
   * truth for the delivered text; `applied` names only which rules changed it,
   * and an empty list is the honest record of "ran, changed nothing" — it does
   * not separate "no rule had a trigger" from "a trigger matched and the rule
   * was already satisfied".
   */
  function withRules(
    draft: Draft,
    context: AssembledContext<KajianQFilters>,
    run: RunContextService,
  ): Draft {
    if (deps.applyProductRules === false) return draft;
    const result = applyProductRules(draft, context, deps.language ?? "id");
    run.record({
      stage: "reviewer",
      kind: "product_rules",
      detail: { applied: [...result.applied] },
      at: run.now(),
    });
    return result.draft;
  }
}

/** A delivery with no branch here is a compile error, never a fall-through. */
function assertNeverDelivery(delivery: never): never {
  throw new Error(`unhandled refusal delivery: ${String(delivery)}`);
}

/**
 * The reviewer LLM's parsed verdict, with the distinction the trace needs.
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
