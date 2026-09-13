import {
  FeedbackResponseSchema,
  type FeedbackRequest,
  type FeedbackResponse,
} from "@app/contracts";
import * as v from "valibot";
import { apiFetch } from "./api";
import { bootstrapAnonymousToken, ChatApiError, errorKindOf, loadStoredToken } from "./chat-store";

/**
 * The feedback client (#13): POST one anonymous feedback row — a thumb on
 * the whole answer or a trace-anchored flag — under the same anonymous
 * Bearer session the chat already uses (ADR-0017: no account). The one-shot
 * 401 retry (fresh anonymous session) mirrors askChat; the response is the
 * persisted row echoed back, validated against the shared contract so a
 * shape the server does not guarantee never renders.
 */
export async function sendFeedback(
  input: FeedbackRequest,
  token: string | null = loadStoredToken(),
  signal?: AbortSignal,
): Promise<FeedbackResponse> {
  let bearer = token ?? (await bootstrapAnonymousToken(signal));
  let res = await postFeedback(input, bearer, signal);
  if (res.status === 401) {
    bearer = await bootstrapAnonymousToken(signal);
    res = await postFeedback(input, bearer, signal);
  }
  if (!res.ok) throw new ChatApiError(errorKindOf(res.status), res.status);
  return v.parse(FeedbackResponseSchema, await res.json());
}

async function postFeedback(
  input: FeedbackRequest,
  bearer: string,
  signal?: AbortSignal,
): Promise<Response> {
  return apiFetch("/feedback", {
    method: "POST",
    token: bearer,
    signal,
    body: JSON.stringify(input),
  });
}
