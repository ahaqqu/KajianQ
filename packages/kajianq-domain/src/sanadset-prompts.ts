/**
 * The arm's prompts and the request-size projection that prices a plan.
 *
 * Two prompt shapes exist per kind of question, and the difference is deliberate: the band
 * prompt may carry the measured trigram score as weak evidence because the cascade already
 * decided the pair is ambiguous, while the sample prompt must not, because a pre-registered
 * pair is an audit of the arm's own judgement and a hint would contaminate the label
 * comparison.
 */

import { estimateTokens } from "./sanadset-arm";
import type { ChatMessage } from "./sanadset-model";

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

export const ESTIMATED_OUTPUT_TOKENS = 12;
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

export function estimateMessages(
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
