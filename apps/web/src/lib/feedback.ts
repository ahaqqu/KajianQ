import {
  FeedbackResponseSchema,
  type FeedbackAnchor,
  type FeedbackRating,
  type FeedbackResponse,
} from "@app/contracts";
import * as v from "valibot";
import { apiFetch } from "./api";
import { bootstrapAnonymousToken, ChatApiError, errorKindOf, loadStoredToken } from "./chat-store";

/**
 * The feedback client (#13): POST /v1/feedback with the anonymous Bearer
 * session the chat already holds (ADR-0017 — zero friction, no account). One
 * request is one feedback shape — a thumb (`rating`) or a trace-anchored flag
 * (`anchor`) — exactly as the shared contract defines it; the server validates
 * the anchor against the persisted trace, so the client only echoes what the
 * frames actually showed the user.
 */

/**
 * The wire payload the feedback affordances build. The anchor is the
 * CONTRACT's `FeedbackAnchor` variant (thermo-review B1), not a hand-rolled
 * `{ type: union; category: string }` — the category↔type pairing holds
 * where the payload is built, so a mismatched combination ("irrelevant_chunk"
 * anchored to a grade badge) cannot typecheck, let alone ship.
 */
export type FeedbackPayload = {
  rating?: FeedbackRating;
  anchor?: FeedbackAnchor;
  freeText?: string;
};

async function postFeedback(
  messageId: string,
  payload: FeedbackPayload,
  bearer: string,
): Promise<Response> {
  return apiFetch("/feedback", {
    method: "POST",
    token: bearer,
    body: JSON.stringify({ messageId, ...payload }),
  });
}

/** POST one feedback row, retrying a 401 once with a fresh anonymous session. */
export async function sendFeedback(
  messageId: string,
  payload: FeedbackPayload,
  token: string | null = loadStoredToken(),
): Promise<FeedbackResponse> {
  let bearer = token ?? (await bootstrapAnonymousToken());
  let res = await postFeedback(messageId, payload, bearer);
  if (res.status === 401) {
    bearer = await bootstrapAnonymousToken();
    res = await postFeedback(messageId, payload, bearer);
  }
  if (!res.ok) throw new ChatApiError(errorKindOf(res.status), res.status);
  return v.parse(FeedbackResponseSchema, await res.json());
}
