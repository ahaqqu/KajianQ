/**
 * The model arm: an OpenAI-compatible chat-completions client for the two accepted
 * providers, with the verdict parsed out of the reply and every call metered.
 *
 * Two brakes live here, below the CLI. The client refuses to issue a request past the
 * pre-registered ceiling, and a reply that is not a verdict is retried exactly once
 * before it is reported as uncertain — a parse failure never becomes a "same".
 * Tokens come from the response's own usage block; only a response that omits usage
 * falls back to a character estimate, and that record is marked `estimated`.
 */

import { estimateTokens, microUsd, type ArmDefinition } from "./sanadset-arm";
import { ModelCallCeilingError } from "./sanadset-budget";
import type { MatnVerdict } from "./sanadset-cascade-types";

export type ArmVerdict = MatnVerdict;
export type ArmPurpose = "matn-band" | "sample-matn" | "sample-narrator";

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };

export type ChatRequestBody = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly max_tokens: number;
  readonly stream: boolean;
};

export type FetchInit = {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
};

export type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export const MATN_SYSTEM_PROMPT =
  "You adjudicate whether two Arabic hadith texts are the same narration. Reply with JSON only: " +
  '{"verdict":"same"|"different"|"uncertain"}. Use "same" only when the two texts narrate the same hadith ' +
  'with the same wording apart from scribal or orthographic variation; use "different" when they are distinct ' +
  'hadiths or merely share a phrase; use "uncertain" when the text does not settle it. Never guess.';

export const NARRATOR_SYSTEM_PROMPT =
  "You adjudicate whether two Arabic narrator names denote the same person. Reply with JSON only: " +
  '{"verdict":"same"|"different"|"uncertain"}. Names carry nasab chains and honorifics, so a short form and a ' +
  'long form may be one person; a shared kunya or nisba alone does not establish identity. Use "uncertain" when ' +
  "the names do not settle it. Never guess.";

/** Output budget for a one-line JSON verdict; the reply is never longer. */
export const VERDICT_MAX_TOKENS = 64;
const ESTIMATED_OUTPUT_TOKENS = 12;
const MESSAGE_OVERHEAD_TOKENS = 4;

export type JudgeInput = { readonly a: string; readonly b: string; readonly score?: number };

export function buildMatnMessages(input: JudgeInput): ChatMessage[] {
  const hint =
    input.score === undefined
      ? ""
      : `\nA trigram-similarity score of ${input.score.toFixed(3)} was measured for this pair; treat it as weak evidence, not as an answer.`;
  return [
    { role: "system", content: MATN_SYSTEM_PROMPT },
    { role: "user", content: `Text A:\n${input.a}\n\nText B:\n${input.b}${hint}` },
  ];
}

export function buildNarratorMessages(input: JudgeInput): ChatMessage[] {
  return [
    { role: "system", content: NARRATOR_SYSTEM_PROMPT },
    { role: "user", content: `Name A: ${input.a}\nName B: ${input.b}` },
  ];
}

function estimateMessages(
  messages: readonly ChatMessage[],
  outputTokens: number,
): { tokensIn: number; tokensOut: number } {
  const tokensIn = messages.reduce(
    (sum, message) => sum + estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS,
    0,
  );
  return { tokensIn, tokensOut: outputTokens };
}

export function estimateMatnCall(input: JudgeInput): { tokensIn: number; tokensOut: number } {
  return estimateMessages(buildMatnMessages(input), ESTIMATED_OUTPUT_TOKENS);
}

export function estimateNarratorCall(input: { readonly a: string; readonly b: string }): {
  tokensIn: number;
  tokensOut: number;
} {
  return estimateMessages(buildNarratorMessages(input), ESTIMATED_OUTPUT_TOKENS);
}

/** Extract the verdict from a reply; anything else is null and may be retried once. */
export function parseVerdict(content: string): ArmVerdict | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const verdict = (parsed as { verdict?: unknown }).verdict;
  return verdict === "same" || verdict === "different" || verdict === "uncertain" ? verdict : null;
}

export type ArmCallRecord = {
  readonly purpose: ArmPurpose;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly costMicroUsd: number;
  readonly estimated: boolean;
  readonly attempts: number;
};

export type ArmTotals = {
  readonly calls: number;
  readonly requests: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly estimated: boolean;
};

export type ArmClient = {
  adjudicateMatn(input: JudgeInput): Promise<ArmVerdict>;
  predictSampleMatn(input: { readonly a: string; readonly b: string }): Promise<ArmVerdict>;
  predictSampleNarrator(input: { readonly a: string; readonly b: string }): Promise<ArmVerdict>;
  calls(): readonly ArmCallRecord[];
  totals(): ArmTotals;
};

export type ArmClientOptions = {
  readonly arm: ArmDefinition;
  readonly apiKey: string;
  /** Hard request ceiling; the client throws before issuing request `ceiling + 1`. */
  readonly ceiling: number;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
};

type Usage = { tokensIn: number; tokensOut: number; estimated: boolean };

function readUsage(payload: unknown, fallbackIn: number): Usage {
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  const tokensIn = usage?.["prompt_tokens"] ?? usage?.["input_tokens"];
  const tokensOut = usage?.["completion_tokens"] ?? usage?.["output_tokens"];
  if (typeof tokensIn === "number" && typeof tokensOut === "number") {
    return { tokensIn, tokensOut, estimated: false };
  }
  return { tokensIn: fallbackIn, tokensOut: ESTIMATED_OUTPUT_TOKENS, estimated: true };
}

function readContent(payload: unknown): string {
  const choices = (payload as { choices?: { message?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function createArmClient(options: ArmClientOptions): ArmClient {
  const doFetch = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 60_000;
  const url = `${options.arm.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const records: ArmCallRecord[] = [];
  let requests = 0;

  const issue = async (body: ChatRequestBody): Promise<unknown> => {
    const attempt = requests + 1;
    if (attempt > options.ceiling) throw new ModelCallCeilingError(requests, options.ceiling);
    requests = attempt;
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.arm.provider} ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A body that is not JSON (an HTML error page with a 200) is an unparseable
      // reply, not an infrastructure failure: it takes the retry-then-uncertain path.
      return {};
    }
  };

  const judge = async (
    purpose: ArmPurpose,
    messages: ChatMessage[],
    fallbackIn: number,
  ): Promise<ArmVerdict> => {
    const body: ChatRequestBody = {
      model: options.arm.model,
      messages,
      temperature: 0,
      max_tokens: VERDICT_MAX_TOKENS,
      stream: false,
    };
    const startedAt = now();
    let tokensIn = 0;
    let tokensOut = 0;
    let estimated = false;
    let attempts = 0;
    let verdict: ArmVerdict | null = null;
    while (attempts < 2 && verdict === null) {
      attempts += 1;
      const payload = await issue(body);
      const usage = readUsage(payload, fallbackIn);
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      estimated = estimated || usage.estimated;
      verdict = parseVerdict(readContent(payload));
    }
    records.push({
      purpose,
      model: options.arm.model,
      tokensIn,
      tokensOut,
      latencyMs: Math.max(0, now() - startedAt),
      costMicroUsd: microUsd(tokensIn, tokensOut, options.arm.price),
      estimated,
      attempts,
    });
    return verdict ?? "uncertain";
  };

  const totals = (): ArmTotals => {
    let tokensIn = 0;
    let tokensOut = 0;
    let costMicroUsd = 0;
    let estimated = false;
    for (const record of records) {
      tokensIn += record.tokensIn;
      tokensOut += record.tokensOut;
      costMicroUsd += record.costMicroUsd;
      estimated = estimated || record.estimated;
    }
    return { calls: records.length, requests, tokensIn, tokensOut, costMicroUsd, estimated };
  };

  return {
    async adjudicateMatn(input: JudgeInput): Promise<ArmVerdict> {
      const messages = buildMatnMessages(input);
      return judge(
        "matn-band",
        messages,
        estimateMessages(messages, ESTIMATED_OUTPUT_TOKENS).tokensIn,
      );
    },
    async predictSampleMatn(input: {
      readonly a: string;
      readonly b: string;
    }): Promise<ArmVerdict> {
      const messages = buildMatnMessages({ a: input.a, b: input.b });
      return judge(
        "sample-matn",
        messages,
        estimateMessages(messages, ESTIMATED_OUTPUT_TOKENS).tokensIn,
      );
    },
    async predictSampleNarrator(input: {
      readonly a: string;
      readonly b: string;
    }): Promise<ArmVerdict> {
      const messages = buildNarratorMessages({ a: input.a, b: input.b });
      return judge(
        "sample-narrator",
        messages,
        estimateMessages(messages, ESTIMATED_OUTPUT_TOKENS).tokensIn,
      );
    },
    calls(): readonly ArmCallRecord[] {
      return records;
    },
    totals,
  };
}
