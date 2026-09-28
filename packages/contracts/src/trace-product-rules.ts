import * as v from "valibot";
import { CostRecordSchema } from "./trace-cost";

/**
 * The `product_rules` trace event variant (#285; ADR-0007 typed detail).
 *
 * It lives in its own module because `trace.ts` is at the agentic 300-line cap
 * and every variant costs ~10 lines of that union — the alternative was
 * deleting another variant's rationale to make room. It is composed into the
 * union verbatim, exactly like the inline variants around it.
 *
 * **What the event means.** The deterministic product rules ran: the rules a
 * domain pack applies to a passed draft after the reviewer gate. This contract
 * stays domain-agnostic, so the rule ids are opaque strings the domain pack
 * owns. Before this kind, the only observable of a fired rule was the text it
 * appended to the delivered answer, so "the rule ran and found the copy
 * already present" was indistinguishable from "the rule never ran".
 *
 * **Why a dedicated kind rather than a field on `review`.** The rules apply on
 * three exits from the reviewer stage — no reviewer configured/`skipLlm`, the
 * ADR-0042 pre-gate skip, and reviewer-passed — and the pre-gate skip records
 * **no `review` event at all**. Folding the rule firing into `review` would
 * have left the very path the #278 staging failure took unobservable.
 *
 * **Reading it.** `applied` names the rule ids that appended text, in
 * application order. An EMPTY array is a meaningful value, not a missing one:
 * the rules ran and appended nothing. It does NOT separate "no rule had a
 * trigger" from "a trigger matched and the copy was already present" — the
 * residual exact-copy suppression case is the motivating example, not a
 * count the field carries. PRESENCE is the signal (the rules ran) — a trace
 * persisted before this kind existed carries no such event, so absence is
 * authoritative only for traces written after it shipped (ADR-0007
 * amendment). The delivered text remains the single source of truth for what
 * the answer says; this event records only which rules appended text, never
 * whether their text survived.
 */
export const productRulesEventSchema = v.object({
  /**
   * Pinned to `reviewer`: the rules are that stage's post-processing, so an
   * event recorded elsewhere is a wiring defect rather than a new adopter.
   */
  stage: v.literal("reviewer"),
  kind: v.literal("product_rules"),
  detail: v.object({
    /** The rule ids that appended text, in order; `[]` = ran, appended nothing. */
    applied: v.array(v.pipe(v.string(), v.minLength(1))),
  }),
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});
