import { Effect } from "effect";
import {
  type DecisionAnswer,
  type DecisionSpec,
  type Decider,
  ProviderError,
  type CostRecord,
} from "@app/rag-core";
import {
  computeCost,
  errorKindForStatus,
  estimateTokens,
  withAttemptCost,
  type FetchLike,
} from "./chat-wire";
import type { ModelConfig, VendorConfig } from "./provider-config";
import { toDecisionAnswer } from "./decision-schema";

/**
 * The typed-questions decision adapter (ADR-0042): one protocol implementation
 * for vendors whose API answers the seam's questions natively over a state.
 * The question objects pass through verbatim — the wire's primitives (a yes/no
 * probability, a choice over a record keyed by the allowed answers, a rating
 * over ordered levels) are the seam's own question types — and the state rides
 * as a one-element array of strings, the envelope the wire validates. Answers
 * come back typed and go through the same validator the chat adapter uses: an
 * answer that arrives malformed, out of range, or off the option set fails the
 * call, never a coerced read. Vendor-identity-free like the chat adapter —
 * endpoint, model id, and prices arrive as config data; `fetch` is injectable
 * so tests drive the wire without a network. The wire bills input tokens only
 * (output is free — the model row prices `out: 0`), so cost is metered from
 * the response's `usage` input count, and a vendor-reaching failure carries
 * its estimated input spend on `attemptCosts` (traceability rule 4).
 */

export type DecisionsDeciderOptions = {
  vendor: VendorConfig;
  modelId: string;
  model: ModelConfig;
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Request timeout; the caller treats timeouts as transport errors. */
  timeoutMs?: number;
};

/** The wire shape of a decisions reply (the subset the seam consumes). */
type DecisionsResponse = {
  model?: string;
  answers?: Record<string, Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function createDecisionsDecider(opts: DecisionsDeciderOptions): Decider {
  const { vendor, modelId, model, apiKey } = opts;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!model.capabilities.includes("decide")) {
    throw new ProviderError({
      kind: "bad_request",
      message: `model ${modelId} does not support decide`,
    });
  }

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  /** Estimated input cost of a vendor-reaching failed attempt (C2, ADR-0022). */
  const attemptCost = (startedAt: number, promptChars: number) =>
    computeCost(
      modelId,
      model.priceMicroUsdPerMTok,
      estimateTokens(promptChars),
      0,
      Date.now() - startedAt,
      true,
    );

  const toProviderError = (cause: unknown): ProviderError =>
    cause instanceof ProviderError
      ? cause
      : new ProviderError({
          kind: "transport",
          message: `request to ${vendor.baseUrl} failed: ${String(cause)}`,
        });

  async function decideWire(spec: DecisionSpec): Promise<{
    answers: Record<string, DecisionAnswer>;
    cost: CostRecord;
  }> {
    const started = Date.now();
    const state = typeof spec.state === "string" ? spec.state : JSON.stringify(spec.state);
    const promptChars = state.length + JSON.stringify(spec.questions).length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${vendor.baseUrl}/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state: [state], model: modelId, questions: spec.questions }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError({
        kind: "transport",
        message: `request to ${vendor.baseUrl}/decisions failed: ${String(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      // 5xx maps to `server` via errorKindForStatus, so the retry policy backs
      // off like any 5xx. The vendor was reached, so the attempt's estimated
      // input spend rides on the error (C2).
      throw withAttemptCost(
        new ProviderError({
          kind: errorKindForStatus(res.status),
          message: `decisions call failed (${res.status}): ${bodyText.slice(0, 300)}`,
        }),
        attemptCost(started, promptChars),
      );
    }
    let json: DecisionsResponse;
    try {
      json = (await res.json()) as DecisionsResponse;
    } catch (err) {
      throw withAttemptCost(
        new ProviderError({
          kind: "transport",
          message: `decisions call returned 200 but the body did not parse: ${String(err)}`,
        }),
        attemptCost(started, promptChars),
      );
    }
    const usage = json.usage ?? {};
    const isMetered = Number.isInteger(usage.input_tokens);
    const tokensIn = isMetered ? (usage.input_tokens as number) : estimateTokens(promptChars);
    // The identity the cost record carries is the build that answered: a
    // vendor that resolves an alias names the dated model in its reply, and
    // tracing the requested alias instead would hide which build was measured.
    const servedModelId =
      typeof json.model === "string" && json.model.length > 0 ? json.model : modelId;
    /** The billed spend of this round trip: input-priced, output free — the
     * row's `out: 0` is what makes the output tokens free, and a reply that
     * fails validation still cost what it cost. */
    const billedCost = (outTokens: number) =>
      computeCost(
        servedModelId,
        model.priceMicroUsdPerMTok,
        tokensIn,
        outTokens,
        Date.now() - started,
        !isMetered,
      );
    const rawAnswers = json.answers;
    if (typeof rawAnswers !== "object" || rawAnswers === null) {
      throw withAttemptCost(
        new ProviderError({
          kind: "transport",
          message: "decisions call has no answers object",
        }),
        billedCost(usage.output_tokens ?? 0),
      );
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const id of Object.keys(spec.questions)) {
      const raw = rawAnswers[id];
      const answer =
        typeof raw === "object" && raw !== null ? toDecisionAnswer(id, raw, spec) : undefined;
      if (answer === undefined) {
        throw withAttemptCost(
          new ProviderError({
            kind: "transport",
            message: `decision answer for "${id}" is malformed, out of range, or off the option set`,
          }),
          billedCost(usage.output_tokens ?? 0),
        );
      }
      answers[id] = answer;
    }
    return { answers, cost: billedCost(usage.output_tokens ?? 0) };
  }

  return {
    modelId,
    decide: (spec) =>
      // The privacy guard at the seam (ADR-0043, ADR-0044 PromptSpec parity):
      // a personal-data spec may never reach a vendor whose config forbids it.
      // The failure is raised before the wire, so the refusal spends nothing
      // and the caller's fail-open path (escalate to the LLM reviewer) runs.
      spec.personalData && !vendor.personalDataAllowed
        ? Effect.fail(
            new ProviderError({
              kind: "bad_request",
              message:
                `model ${modelId}: personal-data decision call, but the vendor at ` +
                `${vendor.baseUrl} does not allow personal data (personalDataAllowed: false)`,
            }),
          )
        : Effect.tryPromise({ try: () => decideWire(spec), catch: toProviderError }),
  };
}
