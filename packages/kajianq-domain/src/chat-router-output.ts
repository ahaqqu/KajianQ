import * as v from "valibot";
import {
  GRADES,
  MADZHABS,
  TEXT_LAYERS,
  type Grade,
  type KajianQFilters,
  type Madzhab,
  type TextLayer,
} from "./filters";
import {
  INTENTS,
  PRINCIPLE_TAGS,
  SUBJECT_AREAS,
  SUB_QUERY_ROLES,
  isIntent,
  isPrincipleTag,
  isSubjectArea,
  type Intent,
  type PrincipleTag,
  type SubjectArea,
  type SubQueryRole,
} from "./taxonomy";
import type { ModelSubQuery } from "./chat-router-decompose";

/**
 * The router LLM's reply, read into the domain's classification vocabulary
 * (Smart Router stages 1–2, spec §3.3).
 *
 * The model's reply is free text and its values are free strings, so every
 * field is narrowed here: an unrecognized value is dropped rather than
 * force-matched into a wrong category, tag, or filter (the same rule the
 * filter hints already followed). Two exceptions are deliberate:
 *
 * - `intent` is required and must be in the vocabulary. It is the field the
 *   Trace presents as *the* classification, so an unusable one means the
 *   reply as a whole is unusable — the router then records the deterministic
 *   fallback instead of passing off an invented intent.
 * - `category` may be absent. It only steers which decomposition rules fire,
 *   and "no subject area was settled" is a real state the Trace can show,
 *   unlike a fabricated one.
 */

/** One `subQueries` entry as the model may write it: a string, or an object. */
const SubQueryReplySchema = v.union([
  v.string(),
  v.object({
    text: v.pipe(v.string(), v.minLength(1)),
    role: v.optional(v.string()),
  }),
]);

/** The reply's JSON object. Keys the model omits take a safe default. */
export const RouterReplySchema = v.object({
  intent: v.pipe(v.string(), v.minLength(1)),
  category: v.optional(v.pipe(v.string(), v.minLength(1))),
  madzhab: v.optional(v.string()),
  grade: v.optional(v.string()),
  textLayer: v.optional(v.string()),
  needsPrinciple: v.optional(v.boolean()),
  principleTags: v.optional(v.array(v.string())),
  confidence: v.optional(v.number()),
  reasoning: v.optional(v.string()),
  subQueries: v.optional(v.array(SubQueryReplySchema)),
});

export type RouterReply = v.InferOutput<typeof RouterReplySchema>;

/** The most Principle tags one reply may contribute (a bound on model output). */
const MAX_PRINCIPLE_TAGS = 3;
/** The longest rationale kept on the Trace (a bound on model output). */
const MAX_REASONING_CHARS = 600;

/**
 * Extract the router LLM's JSON object. The reply must yield an object
 * carrying the contract's core key — the old first-`{`-to-last-`}` slice
 * accepted any stray-braced prose. `undefined` when extraction fails, so the
 * caller records the fallback instead of silently degrading.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed !== null && typeof parsed === "object" && "intent" in parsed) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/** What the domain read out of one reply. */
export type RouterReading = {
  intent: Intent;
  category?: SubjectArea;
  needsPrinciple: boolean;
  principleTags: readonly PrincipleTag[];
  /** The model's sub-queries, in its own order. */
  modelSubQueries: readonly ModelSubQuery[];
  /** Effective retrieval filters: the caller's overrides win over the hints. */
  filters: KajianQFilters;
  /** The model's self-reported confidence in `intent`, when it is usable. */
  confidence?: number;
  /** The model's rationale for the classification, bounded and trimmed. */
  reasoning?: string;
  /**
   * The Trace's opaque classification payload: the subject area, the principle
   * decision, and the effective filters. Built once here so the trace and the
   * routing decision can never disagree about what was understood.
   */
  attributes: Record<string, unknown>;
};

/**
 * Parse a raw reply into a reading, or `undefined` when the reply is unusable
 * — unparseable JSON, no JSON object, or a classification outside the
 * vocabulary. The caller records the deterministic fallback in that case.
 */
export function readRouterText(text: string, overrides: KajianQFilters): RouterReading | undefined {
  const parsed = v.safeParse(RouterReplySchema, extractJsonObject(text));
  return parsed.success ? readRouterReply(parsed.output, overrides) : undefined;
}

/** Read a reply into the vocabularies, or `undefined` when it is unusable. */
export function readRouterReply(
  reply: RouterReply,
  overrides: KajianQFilters,
): RouterReading | undefined {
  const intent = isIntent(reply.intent) ? reply.intent : undefined;
  if (intent === undefined) return undefined;

  const category =
    reply.category !== undefined && isSubjectArea(reply.category) ? reply.category : undefined;

  const principleTags: PrincipleTag[] = [];
  for (const raw of reply.principleTags ?? []) {
    if (!isPrincipleTag(raw) || principleTags.includes(raw)) continue;
    principleTags.push(raw);
    if (principleTags.length === MAX_PRINCIPLE_TAGS) break;
  }
  // A tag is itself the model's statement that this question turns on a lens:
  // a reply that names one needs the Principle sub-query even if it left the
  // flag out.
  const needsPrinciple = reply.needsPrinciple === true || principleTags.length > 0;

  const filters: KajianQFilters = {};
  const madzhab = overrides.madzhab ?? narrowMadzhab(reply.madzhab);
  const grade = overrides.grade ?? narrowGrade(reply.grade);
  const textLayer = overrides.textLayer ?? narrowTextLayer(reply.textLayer);
  if (madzhab !== undefined) filters.madzhab = madzhab;
  if (grade !== undefined) filters.grade = grade;
  if (textLayer !== undefined) filters.textLayer = textLayer;

  const confidence =
    reply.confidence !== undefined &&
    Number.isFinite(reply.confidence) &&
    reply.confidence >= 0 &&
    reply.confidence <= 1
      ? reply.confidence
      : undefined;
  const reasoning = normalizeReasoning(reply.reasoning);

  const attributes: Record<string, unknown> = { needsPrinciple };
  if (category !== undefined) attributes["category"] = category;
  if (principleTags.length > 0) attributes["principleTags"] = principleTags;
  Object.assign(attributes, filters);

  return {
    intent,
    ...(category !== undefined ? { category } : {}),
    needsPrinciple,
    principleTags,
    modelSubQueries: (reply.subQueries ?? []).map((entry) =>
      typeof entry === "string"
        ? { text: entry }
        : { text: entry.text, ...(entry.role !== undefined ? { role: entry.role } : {}) },
    ),
    filters,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    attributes,
  };
}

/** A blank or whitespace-only rationale is no rationale. */ function normalizeReasoning(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > MAX_REASONING_CHARS ? trimmed.slice(0, MAX_REASONING_CHARS) : trimmed;
}

function narrowMadzhab(value: string | undefined): Madzhab | undefined {
  return value !== undefined && (MADZHABS as readonly string[]).includes(value)
    ? (value as Madzhab)
    : undefined;
}

function narrowGrade(value: string | undefined): Grade | undefined {
  return value !== undefined && (GRADES as readonly string[]).includes(value)
    ? (value as Grade)
    : undefined;
}

function narrowTextLayer(value: string | undefined): TextLayer | undefined {
  return value !== undefined && (TEXT_LAYERS as readonly string[]).includes(value)
    ? (value as TextLayer)
    : undefined;
}

/**
 * The router's prompt — stages 1–2 in one cheap-tier call: the classification,
 * the filter hints, and the role-tagged sub-queries. The composition rules are
 * stated here for the model, and enforced afterwards by the domain (a cheap
 * model obeying a count is exactly what it does not reliably do); a sub-query
 * the model leaves out for a rule that fired is added deterministically, and
 * the Trace shows which one.
 *
 * Every vocabulary the reply may use is *composed* from the list that owns it
 * (the taxonomy and the filter dimensions) at module load — so a value added to
 * one list is offered to the model in the same edit, and a value the reader
 * would narrow cannot go unrequested. The rules line is the one place the
 * prompt *names* vocabulary values in prose, and it names each one through the
 * owner's own type, so renaming a value there fails the build instead of
 * leaving the prompt offering a value the reader would then drop (review
 * R1-B1). This is the same one-owner rule the reader's narrowing follows.
 */
const alternatives = (values: readonly string[]): string => values.join("|");

/** A declared sub-query role, named by the rules prose below. */
const role = (value: SubQueryRole): SubQueryRole => value;

/** A declared subject area, named by the rules prose below. */
const area = (value: SubjectArea): SubjectArea => value;

export const ROUTER_SYSTEM_PROMPT = [
  "You are the routing stage of a classical Islamic knowledge retrieval system.",
  "Given the user's question, reply with ONLY a JSON object:",
  `{"intent": "${alternatives(INTENTS)}",`,
  ` "category": "${alternatives(SUBJECT_AREAS)}",`,
  ` "madzhab": "" | "${alternatives(MADZHABS)}",`,
  ` "grade": "" | "${alternatives(GRADES)}",`,
  ` "textLayer": "" | "${alternatives(TEXT_LAYERS)}",`,
  ' "needsPrinciple": true | false,',
  ` "principleTags": [] | ["${alternatives(PRINCIPLE_TAGS)}"],`,
  ' "confidence": 0.0-1.0,',
  ' "reasoning": "one short sentence",',
  ` "subQueries": [{"text": "a focused retrieval query", "role": "${alternatives(SUB_QUERY_ROLES)}"}]}`,
  "Rules for subQueries — 2 to 4 of them, each phrased as a retrieval query:",
  `always one "${role("factual")}"; one "${role("principle")}" when needsPrinciple; one "${role("dalil")}" when category is ${area("fikih")}; one "${role("sanad")}" when category is ${area("hadith")}.`,
  "Mix the question's language with its classical terms, and use different angles rather than repeating the question.",
  'Use "" or [] for filters the question does not constrain. No prose outside the JSON.',
].join("\n");
