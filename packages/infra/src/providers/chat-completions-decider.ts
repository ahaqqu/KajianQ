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
  type ChatResponse,
  type FetchLike,
} from "./chat-wire";
import {
  resolveChain,
  type ModelConfig,
  type ProviderConfig,
  type VendorConfig,
} from "./provider-config";
import {
  answersSchema,
  DECISION_SYSTEM_PROMPT,
  toDecisionAnswer,
  type RawAnswers,
} from "./decision-schema";

/**
 * The chat-completions decision adapter (ADR-0042, rewritten in place with
 * ADR-0069's migration): the decision seam rides the same chat-completions
 * vendor as generation, with the question typing carried by a strict JSON
 * schema on the request (`response_format`) and the answers validated back
 * into `DecisionAnswer` before anything downstream reads them. The schema
 * enforcement is what separates this from free-form prompting: a vendor that
 * ignores the schema fails the parse here, and the caller's fail-open path
 * (ADR-0042) treats it exactly like any vendor failure. Vendor-identity-free
 * like the chat adapter — endpoint, model id, and prices arrive as config
 * data; `fetch` is injectable so tests drive the wire without a network.
 * Cost is metered from the response's `usage`; a vendor-reaching failure
 * carries its estimated input spend on `attemptCosts` (traceability rule 4).
 */

export type ChatCompletionsDeciderOptions = {
  vendor: VendorConfig;
  modelId: string;
  model: ModelConfig;
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Request timeout; the caller treats timeouts as transport errors. */
  timeoutMs?: number;
};

export function createChatCompletionsDecider(opts: ChatCompletionsDeciderOptions): Decider {
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
    const stateChars =
      typeof spec.state === "string" ? spec.state.length : JSON.stringify(spec.state).length;
    const promptChars = stateChars + JSON.stringify(spec.questions).length;
    const body = {
      model: modelId,
      messages: [
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ state: spec.state, questions: spec.questions }) },
      ],
      response_format: answersSchema(spec),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${vendor.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError({
        kind: "transport",
        message: `request to ${vendor.baseUrl}/chat/completions failed: ${String(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw withAttemptCost(
        new ProviderError({
          kind: errorKindForStatus(res.status),
          message: `chat/completions decision call failed (${res.status}): ${bodyText.slice(0, 300)}`,
        }),
        attemptCost(started, promptChars),
      );
    }
    let json: ChatResponse;
    try {
      json = (await res.json()) as ChatResponse;
    } catch (err) {
      throw withAttemptCost(
        new ProviderError({
          kind: "transport",
          message: `decision call returned 200 but the body did not parse: ${String(err)}`,
        }),
        attemptCost(started, promptChars),
      );
    }
    const settle = (answers: Record<string, DecisionAnswer>, estimatedOut: number) => {
      const isMetered =
        typeof json.usage?.prompt_tokens === "number" &&
        typeof json.usage?.completion_tokens === "number";
      const tokensIn = isMetered ? json.usage!.prompt_tokens! : estimateTokens(promptChars);
      return {
        answers,
        cost: computeCost(
          modelId,
          model.priceMicroUsdPerMTok,
          tokensIn,
          isMetered ? json.usage!.completion_tokens! : estimatedOut,
          Date.now() - started,
          !isMetered,
        ),
      };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    /** The error a post-200 refusal carries: the vendor was reached and billed
     * the attempt, so the spend stays on the trail (estimated output — the
     * answer still cost what it cost), and the caller's fail-open path reads
     * the transport failure like any vendor failure. */
    const contentRefusal = (message: string) =>
      withAttemptCost(
        new ProviderError({ kind: "transport", message }),
        settle({}, estimateTokens(content.length)).cost,
      );
    let parsed: { answers?: RawAnswers };
    try {
      parsed = JSON.parse(content) as { answers?: RawAnswers };
    } catch {
      throw contentRefusal("decision call returned content that is not JSON");
    }
    const rawAnswers = parsed.answers;
    if (typeof rawAnswers !== "object" || rawAnswers === null) {
      throw contentRefusal("decision call has no answers object");
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const id of Object.keys(spec.questions)) {
      const raw = rawAnswers[id];
      const answer =
        typeof raw === "object" && raw !== null
          ? toDecisionAnswer(id, raw as Record<string, unknown>, spec)
          : undefined;
      if (answer === undefined) {
        throw contentRefusal(
          `decision answer for "${id}" is malformed, out of range, or off the option set`,
        );
      }
      answers[id] = answer;
    }
    return settle(answers, 0);
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

/**
 * Resolve a role's decision candidates (ADR-0022 discipline, ADR-0042): only
 * keyed candidates are wired; a candidate without a key is reported in
 * `missingKeys` instead of silently skipped, so the bench CLI can print
 * NOT RUN and stay green in CI.
 *
 * `personalData: true` is the serving posture (ADR-0043): candidates whose
 * vendor forbids personal data are dropped — a free-tier decision vendor may
 * never carry the reviewer's claim spans — and each drop is reported in
 * `ineligibleKeys` (the key is not the problem, so it is never listed as
 * missing). The call-time guard in the adapter is the hard stop; this filter
 * keeps an ineligible candidate off the serving role in the first place. The
 * bench resolves without the flag, so its candidate set is unchanged.
 */
export function resolveDecider(
  config: ProviderConfig,
  role: string,
  opts: {
    env: Record<string, string | undefined>;
    /** Serving posture: only vendors that allow personal data may be wired. */
    personalData?: boolean;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  },
): {
  deciders: { modelId: string; decider: Decider }[];
  missingKeys: string[];
  ineligibleKeys: string[];
} {
  const deciders: { modelId: string; decider: Decider }[] = [];
  const missingKeys: string[] = [];
  const ineligibleKeys: string[] = [];
  for (const candidate of resolveChain(config, role)) {
    if (opts.personalData === true && !candidate.vendorConfig.personalDataAllowed) {
      if (!ineligibleKeys.includes(candidate.vendorConfig.apiKeyEnv)) {
        ineligibleKeys.push(candidate.vendorConfig.apiKeyEnv);
      }
      continue;
    }
    const apiKey = opts.env[candidate.vendorConfig.apiKeyEnv];
    if (!apiKey) {
      // Distinct names only: a chain can key two candidates to one env (the
      // aggregator does), and the report names variables, not candidates.
      if (!missingKeys.includes(candidate.vendorConfig.apiKeyEnv)) {
        missingKeys.push(candidate.vendorConfig.apiKeyEnv);
      }
      continue;
    }
    if (candidate.vendorConfig.protocol !== "chat-completions") {
      throw new Error(
        `decider role "${role}": candidate ${candidate.vendor}:${candidate.modelId} does not speak the chat-completions protocol`,
      );
    }
    deciders.push({
      modelId: candidate.modelId,
      decider: createChatCompletionsDecider({
        vendor: candidate.vendorConfig,
        modelId: candidate.modelId,
        model: candidate.modelConfig,
        apiKey,
        ...(opts.fetchImpl != null ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    });
  }
  return { deciders, missingKeys, ineligibleKeys };
}
