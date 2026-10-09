/**
 * KajianQ's classification vocabularies — the single source of truth.
 *
 * Everything that names a subject area, an intent, a Principle tag, a
 * sub-query role or origin, or a Golden Set label reads it from here: the
 * router's prompt, the router's narrowing of the model's reply, the Golden Set
 * fixture, and the eval CLI's trap marker. Changing a vocabulary is a change
 * to one list in this file, never a second list or a second spelling.
 *
 * These are domain terms (CONTEXT.md: Query category, Intent, Principle tag,
 * Sub-query), so they live in the domain pack. The engine packages carry the
 * router's output opaquely and name none of them.
 */

/**
 * Query category (CONTEXT.md) — the subject area a question falls in. The
 * first two values are the corpus's own `sourceType` labels; the rest name
 * areas the corpus grows into.
 */
export const SUBJECT_AREAS = [
  "quran",
  "hadith",
  "tafsir",
  "fikih",
  "aqidah",
  "tasawuf",
  "sejarah",
  "adab",
  "general",
] as const;
export type SubjectArea = (typeof SUBJECT_AREAS)[number];

/** Intent (CONTEXT.md) — what kind of question was asked. */
export const INTENTS = ["factual", "ruling", "analogy", "comparison", "history", "aqidah"] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Principle tag (CONTEXT.md) — the interpretive lens a why-question or an
 * analogy needs. The Principle Index (#16) seeds its rows with these exact
 * slugs, so the router's tags and the index's rows line up by construction.
 */
export const PRINCIPLE_TAGS = [
  "yusr",
  "rahmah",
  "masyaqqah",
  "dharar",
  "umum_balwa",
  "istihsan",
  "sad_zari",
] as const;
export type PrincipleTag = (typeof PRINCIPLE_TAGS)[number];

/**
 * Sub-query role (CONTEXT.md "Sub-query") — what a decomposed retrieval query
 * is for.
 *
 * All four are Smart Router stage 2's composition rules, and all four fire as
 * rules on today's path: `factual` always, `principle` when the question needs a
 * lens, `dalil` when the category is fikih, and `sanad` when it is hadith — see
 * `requiredRoles` in `chat-router-decompose.ts`. No role here waits for a later
 * layer: the corpus and knowledge layers that arrive later add the content a
 * role retrieves, not the role itself.
 */
export const SUB_QUERY_ROLES = ["factual", "principle", "dalil", "sanad"] as const;
export type SubQueryRole = (typeof SUB_QUERY_ROLES)[number];

/**
 * Sub-query origin — what produced a sub-query. `model` is the router LLM's
 * own phrasing; `rule` is one the domain added because a composition rule was
 * left uncovered; `fallback` is the single sub-query used when the router's
 * reply was unusable. The trace carries the label, so a rule-added or
 * fallback sub-query is never read as the model's own judgment.
 */
export const SUB_QUERY_ORIGINS = ["model", "rule", "fallback"] as const;
export type SubQueryOrigin = (typeof SUB_QUERY_ORIGINS)[number];

/**
 * Golden Set labels — what the eval fixture's `tags` may say about a question
 * *besides* its subject areas: which dimension it exercises. These are eval
 * metadata, not routing vocabulary; the router never sees them.
 */
export const GOLDEN_SET_LABELS = [
  "grade-check",
  "english",
  "cross-madzhab",
  "refusal",
  "unanswerable",
  "dhaif-trap",
  "fabricated-attribution",
] as const;
export type GoldenSetLabel = (typeof GOLDEN_SET_LABELS)[number];

/** Every label a Golden Set question may carry. */
export const GOLDEN_SET_TAG_VOCABULARY: readonly string[] = [
  ...SUBJECT_AREAS,
  ...GOLDEN_SET_LABELS,
];

/**
 * The label that marks the Golden Set's dhaif-hadith trap. The eval's v0
 * content bar asserts a question carrying it exists, so the marker is named
 * once here rather than spelled again at the assertion site.
 */
export const DAIF_TRAP_LABEL = "dhaif-trap";

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** Narrow a free string to a subject area (the model's reply is free text). */
export function isSubjectArea(value: string): value is SubjectArea {
  return oneOf(SUBJECT_AREAS, value);
}

/** Narrow a free string to an intent. */
export function isIntent(value: string): value is Intent {
  return oneOf(INTENTS, value);
}

/** Narrow a free string to a Principle tag. */
export function isPrincipleTag(value: string): value is PrincipleTag {
  return oneOf(PRINCIPLE_TAGS, value);
}
