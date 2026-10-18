import { Effect } from "effect";
import type { Decliner, RoutedQuery } from "@app/rag-core";
import type { RefusalTrigger } from "./chat-refusal";
import type { ChatLanguage } from "./chat-prompts";
import type { KajianQFilters } from "./filters";

/**
 * The Content-free decline: the answer the run delivers when its route carries
 * no question at all, so there is nothing to generate.
 *
 * The route's own marking is the whole test, and that is deliberate. The router
 * asks the caller's text for a letter or a digit before it calls a model, and a
 * text that has neither comes back marked `contentFree` on the intent event;
 * reading that marking rather than re-testing the text keeps ONE content test in
 * the product, so the answer this declines for is exactly the route that was
 * declined. A second spelling of the test here could disagree with the route it
 * is supposed to match.
 *
 * The copy is product copy — canned and localized (`id` first, `en` alongside),
 * so the same input always yields the same answer. That is what makes the
 * decline cost nothing by construction rather than by measurement: there is no
 * call to price. It is deliberately NOT the refusal copy: a decline says the
 * message carried no question, a Refusal says the retrieved evidence did not
 * support one, and a reader must be able to tell the two apart without reading
 * the trace.
 */

/** The route attribute the router's gate publishes; this module owns its key. */
const CONTENT_FREE = "contentFree";

/**
 * The decline's `refusal` event trigger. One of `RefusalTrigger`'s members but
 * not a Refusal's: it is the record of an answer the product wrote instead of
 * generating one, which is the fact that event kind carries for every reader of
 * it.
 */
export const CONTENT_FREE_DECLINE_TRIGGER = "content_free_decline" satisfies RefusalTrigger;

/** The decline's copy, one entry per answer language. */
export const CONTENT_FREE_DECLINE_TEXT: Record<ChatLanguage, string> = {
  id: "Mohon maaf, kami tidak menemukan pertanyaan pada pesan Anda.",
  en: "Sorry, we could not find a question in your message.",
};

/** The `refusal` event's account of why the run answered with product copy. */
export const CONTENT_FREE_DECLINE_REASON =
  "the route carries no question, so no answer is generated for it";

/**
 * True when the router declined the caller's text as a non-question. Absent
 * attributes, or a marking that is not exactly `true`, is not a decline: a route
 * the model read is never a content-free one.
 */
export function isContentFreeRoute(routed: RoutedQuery<KajianQFilters>): boolean {
  return routed.attributes?.[CONTENT_FREE] === true;
}

/**
 * The decline seam the runner consults after assembly: a content-free route is
 * answered from the canned copy, and the generator and the reviewer are never
 * entered.
 */
export function createContentFreeDecliner(deps: {
  language: ChatLanguage;
}): Decliner<KajianQFilters> {
  return {
    decline: (routed) =>
      Effect.succeed(
        isContentFreeRoute(routed)
          ? {
              text: CONTENT_FREE_DECLINE_TEXT[deps.language],
              reason: CONTENT_FREE_DECLINE_REASON,
              trigger: CONTENT_FREE_DECLINE_TRIGGER,
            }
          : null,
      ),
  };
}
