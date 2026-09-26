import { Effect } from "effect";
import {
  type DecisionAnswer,
  type DecisionSpec,
  type Decider,
  ProviderError,
  type CostRecord,
} from "@app/rag-core";
import { computeCost, estimateTokens, withAttemptCost } from "./chat-wire";
import { errorKindForStatus, type FetchLike } from "./chat-completions-adapter";
import {
  resolveChain,
  type ModelConfig,
  type ProviderConfig,
  type VendorConfig,
} from "./provider-config";

/**
 * The systemone decision adapter (ADR-0042): one protocol implementation for
 * vendors whose API answers typed questions (Choice/Score/Noul) over a state.
 * Vendor-identity-free like the chat adapter — endpoint, model id, and prices
 * all arrive as config data; `fetch` is injectable so tests drive the wire
 * without a network. Cost is metered from the response's `usage` (input
 * tokens only per the wire contract); a vendor-reaching failure carries its
 * estimated input spend on `attemptCosts` (traceability rule 4).
 */

export type SystemOneOptions = {
  vendor: VendorConfig;
  modelId: string;
  model: ModelConfig;
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Request timeout; the caller treats timeouts as transport errors. */
  timeoutMs?: number;
};

/** The wire shape of a systemone response (the subset the seam consumes). */
type SystemOneResponse = {
  model?: string;
  answers?: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function createSystemOneDecider(opts: SystemOneOptions): Decider {
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
  const attemptCost = (startedAt: number, stateChars: number) =>
    computeCost(
      modelId,
      model.priceMicroUsdPerMTok,
      estimateTokens(stateChars),
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${vendor.baseUrl}/systemone`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state: spec.state, model: modelId, questions: spec.questions }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError({
        kind: "transport",
        message: `request to ${vendor.baseUrl}/systemone failed: ${String(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 529 (overloaded) maps to `server` via errorKindForStatus (>= 500),
      // so the retry policy backs off like any 5xx. The vendor was reached,
      // so the attempt's estimated input spend rides on the error (C2).
      throw withAttemptCost(
        new ProviderError({
          kind: errorKindForStatus(res.status),
          message: `systemone failed (${res.status}): ${body.slice(0, 300)}`,
        }),
        attemptCost(started, stateChars),
      );
    }
    let json: SystemOneResponse;
    try {
      json = (await res.json()) as SystemOneResponse;
    } catch (err) {
      throw withAttemptCost(
        new ProviderError({
          kind: "transport",
          message: `systemone returned 200 but the body did not parse: ${String(err)}`,
        }),
        attemptCost(started, stateChars),
      );
    }
    if (!json.answers || typeof json.answers !== "object") {
      throw withAttemptCost(
        new ProviderError({
          kind: "transport",
          message: "systemone response has no answers object",
        }),
        attemptCost(started, stateChars),
      );
    }
    const usage = json.usage ?? {};
    const isMetered = Number.isInteger(usage.input_tokens);
    const tokensIn = isMetered ? (usage.input_tokens as number) : estimateTokens(stateChars);
    return {
      answers: json.answers,
      cost: computeCost(
        modelId,
        model.priceMicroUsdPerMTok,
        tokensIn,
        usage.output_tokens ?? 0,
        Date.now() - started,
        !isMetered,
      ),
    };
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
      ineligibleKeys.push(candidate.vendorConfig.apiKeyEnv);
      continue;
    }
    const apiKey = opts.env[candidate.vendorConfig.apiKeyEnv];
    if (!apiKey) {
      missingKeys.push(candidate.vendorConfig.apiKeyEnv);
      continue;
    }
    if (candidate.vendorConfig.protocol !== "systemone") {
      throw new Error(
        `decider role "${role}": candidate ${candidate.vendor}:${candidate.modelId} does not speak the systemone protocol`,
      );
    }
    deciders.push({
      modelId: candidate.modelId,
      decider: createSystemOneDecider({
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
