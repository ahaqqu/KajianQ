import { Effect } from "effect";
import {
  type DecisionAnswer,
  type DecisionSpec,
  type Decider,
  ProviderError,
  type CostRecord,
} from "@app/rag-core";
import { computeCost, estimateTokens } from "./chat-wire";
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
      // so the retry policy backs off like any 5xx.
      throw new ProviderError({
        kind: errorKindForStatus(res.status),
        message: `systemone failed (${res.status}): ${body.slice(0, 300)}`,
      });
    }
    let json: SystemOneResponse;
    try {
      json = (await res.json()) as SystemOneResponse;
    } catch (err) {
      throw new ProviderError({
        kind: "transport",
        message: `systemone returned 200 but the body did not parse: ${String(err)}`,
      });
    }
    if (!json.answers || typeof json.answers !== "object") {
      throw new ProviderError({
        kind: "transport",
        message: "systemone response has no answers object",
      });
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
    decide: (spec) => Effect.tryPromise({ try: () => decideWire(spec), catch: toProviderError }),
  };
}

/**
 * Resolve a role's decision candidates (ADR-0022 discipline, ADR-0042): only
 * keyed candidates are wired; a candidate without a key is reported in
 * `missingKeys` instead of silently skipped, so the bench CLI can print
 * NOT RUN and stay green in CI.
 */
export function resolveDecider(
  config: ProviderConfig,
  role: string,
  opts: { env: Record<string, string | undefined>; fetchImpl?: FetchLike; timeoutMs?: number },
): { deciders: { modelId: string; decider: Decider }[]; missingKeys: string[] } {
  const deciders: { modelId: string; decider: Decider }[] = [];
  const missingKeys: string[] = [];
  for (const candidate of resolveChain(config, role)) {
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
  return { deciders, missingKeys };
}
