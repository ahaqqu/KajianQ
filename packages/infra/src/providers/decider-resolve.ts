import type { Decider } from "@app/rag-core";
import { createChatCompletionsDecider } from "./chat-completions-decider";
import { createDecisionsDecider } from "./decisions-decider";
import { resolveChain, type ProviderConfig } from "./provider-config";
import type { FetchLike } from "./chat-wire";

/**
 * Role resolution for the decision seam (ADR-0022 discipline, ADR-0042): the
 * protocol dispatch that turns a role's ordered candidates into `Decider`
 * instances. The chat wire pins the answers schema on the request; the
 * typed-questions wire carries the primitives natively — both construct a
 * `Decider` over the same validated seam answers, chosen per candidate by the
 * vendor row's `protocol`.
 */

/**
 * Resolve a role's decision candidates: only keyed candidates are wired; a
 * candidate without a key is reported in `missingKeys` instead of silently
 * skipped, so the bench CLI can print NOT RUN and stay green in CI.
 *
 * `personalData: true` is the serving posture (ADR-0043): candidates whose
 * vendor forbids personal data are dropped — a free-tier decision vendor may
 * never carry the reviewer's claim spans — and each drop is reported in
 * `ineligibleKeys` (the key is not the problem, so it is never listed as
 * missing). The call-time guard in each adapter is the hard stop; this filter
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
    const adapterOptions = {
      vendor: candidate.vendorConfig,
      modelId: candidate.modelId,
      model: candidate.modelConfig,
      apiKey,
      ...(opts.fetchImpl != null ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    };
    deciders.push({
      modelId: candidate.modelId,
      decider:
        candidate.vendorConfig.protocol === "chat-completions"
          ? createChatCompletionsDecider(adapterOptions)
          : createDecisionsDecider(adapterOptions),
    });
  }
  return { deciders, missingKeys, ineligibleKeys };
}
