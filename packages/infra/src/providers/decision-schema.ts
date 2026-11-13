import type { DecisionAnswer, DecisionSpec } from "@app/rag-core";

/**
 * The decision call's schema and validation, split from the adapter (agentic
 * size limit): the prompt text, the strict JSON schema the request pins, and
 * the validator that turns the model's raw answer object into the seam's typed
 * answer. No vendor or model names — everything arrives as spec/config data.
 */

export const DECISION_SYSTEM_PROMPT = [
  "You answer typed questions about a provided state.",
  'Type "noul": answer with `noul`, the probability from 0 to 1 that the answer is yes.',
  'Type "choice": answer with `choice`, the id of the one best option, plus `probabilities` (one number per option id, each 0 to 1) and `confidence` (0 to 1).',
  'Type "score": answer with `score`, the probability-weighted level position between 0 and the highest level index, plus `probabilities` (one number per level index, each 0 to 1) and `confidence` (0 to 1).',
  'Reply with JSON only, shaped {"answers": {"<question id>": {...}}}, one entry per question, using the exact ids given.',
].join(" ");

/** The wire-level answers payload: question id → the model's raw answer. */
export type RawAnswers = Record<string, Record<string, unknown>>;

/** A JSON Schema per question type, so `strict` enforcement pins the answer's
 * shape per question — the typing the wire itself carries. */
function answerSchema(question: DecisionSpec["questions"][string]): Record<string, unknown> {
  const number = { type: "number" };
  const probabilities = { type: "object", additionalProperties: number };
  switch (question.type) {
    case "noul":
      return {
        type: "object",
        properties: { noul: number },
        required: ["noul"],
        additionalProperties: false,
      };
    case "choice":
      return {
        type: "object",
        properties: { choice: { type: "string" }, probabilities, confidence: number },
        required: ["choice", "probabilities", "confidence"],
        additionalProperties: false,
      };
    case "score":
      return {
        type: "object",
        properties: { score: number, probabilities, confidence: number },
        required: ["score", "probabilities", "confidence"],
        additionalProperties: false,
      };
  }
}

export function answersSchema(spec: DecisionSpec): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "decision_answers",
      strict: true,
      schema: {
        type: "object",
        properties: {
          answers: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(spec.questions).map(([id, question]) => [id, answerSchema(question)]),
            ),
            required: Object.keys(spec.questions),
            additionalProperties: false,
          },
        },
        required: ["answers"],
        additionalProperties: false,
      },
    },
  };
}

/** Turn the model's raw answer object into the seam's typed answer, refusing
 * anything doubtful — ADR-0042: "malformed, out of range, or off the option
 * set fails the call", never a coerced answer. The ranges this validator
 * enforces, exactly: `noul` and `confidence` in [0, 1]; a `choice` on the
 * option set with every probability value in [0, 1]; a `score` in
 * [0, levels − 1] (a probability-weighted level position) with every
 * probability value in [0, 1]. Anything else is undefined, and the adapter
 * fails the call. */
export function toDecisionAnswer(
  id: string,
  raw: Record<string, unknown>,
  spec: DecisionSpec,
): DecisionAnswer | undefined {
  const isUnit = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const asProbabilityMap = (v: unknown): Record<string, number> | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const out: Record<string, number> = {};
    for (const [key, p] of Object.entries(v as Record<string, unknown>)) {
      if (!isUnit(p)) return undefined;
      out[key] = p;
    }
    return out;
  };
  const question = spec.questions[id];
  if (question === undefined) return undefined;
  if (question.type === "noul") {
    return isUnit(raw.noul) ? { type: "noul", noul: raw.noul } : undefined;
  }
  if (question.type === "choice") {
    const optionIds = Object.keys(question.criteria);
    if (typeof raw.choice !== "string") return undefined;
    if (optionIds.length > 0 && !optionIds.includes(raw.choice)) return undefined;
    const probabilities = asProbabilityMap(raw.probabilities);
    if (probabilities === undefined || !isUnit(raw.confidence)) return undefined;
    return { type: "choice", choice: raw.choice, probabilities, confidence: raw.confidence };
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) return undefined;
  const levels = question.criteria.length;
  if (raw.score < 0 || raw.score > levels - 1) return undefined;
  const probabilities = asProbabilityMap(raw.probabilities);
  if (probabilities === undefined || !isUnit(raw.confidence)) return undefined;
  // The legend is the question's own rubric (deterministic config data), never
  // the model's echo of it; the keys are the levels' positions.
  const legend = Object.fromEntries(Object.entries(question.criteria as readonly string[]));
  return { type: "score", score: raw.score, legend, probabilities, confidence: raw.confidence };
}
