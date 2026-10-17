// @contracts-internal: composed into the TraceEvent union in ./trace-events.ts — a reader parses that union and branches on `kind`, never on a variant module.
import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * The `product_rules` trace event variant (ADR-0007 typed detail).
 *
 * It is composed into the union in `./trace-events.ts` verbatim, exactly like
 * the inline variants around it, so `kind` remains the union's one
 * discriminator. The cost shape it carries is `./trace-primitives.ts`'s
 * `CostRecordSchema` — the contract's one owner of that shape; a variant
 * imports it from there and never restates it.
 *
 * **What the event means.** The deterministic product rules ran: the rules a
 * domain pack applies to a passed draft after the reviewer gate. This contract
 * stays domain-agnostic, so the rule ids are opaque strings the domain pack
 * owns. The delivered answer text alone cannot separate "the rule ran and found
 * the copy already present" from "the rule never ran", which is why the event
 * exists.
 *
 * **Why a dedicated kind rather than a field on `review`.** The rules apply on
 * three exits from the reviewer stage — no reviewer configured/`skipLlm`, the
 * ADR-0042 pre-gate skip, and reviewer-passed — and the pre-gate skip records
 * **no `review` event at all**. Folding the rules into `review` would leave
 * that path unobservable.
 *
 * **Reading it.** `applied` names the rule ids that appended text, in
 * application order. An EMPTY array is a meaningful value, not a missing one:
 * the rules ran and appended nothing. It does NOT separate "no rule had a
 * trigger" from "a trigger matched and the copy was already present" — the
 * residual exact-copy suppression case is the motivating example, not a
 * count the field carries. PRESENCE is the signal (the rules ran); absence is
 * authoritative only for traces written after the event shipped (ADR-0007).
 * The delivered text remains the single source of truth for what
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
