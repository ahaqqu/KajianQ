import type { SubQuery } from "@app/rag-core";
import {
  SUB_QUERY_ROLES,
  type PrincipleTag,
  type SubjectArea,
  type SubQueryRole,
} from "./taxonomy";

/**
 * Query decomposition (CONTEXT.md) — Smart Router stage 2, made deterministic
 * where it has to be.
 *
 * The router LLM phrases the sub-queries: its paraphrases and classical-term
 * choices are what make retrieval work, and a template cannot reproduce them.
 * What a cheap model does *not* do reliably is obey a count or cover a rule it
 * was given, so the domain repairs the reply here, deterministically:
 *
 *   1. every composition rule that fired has a sub-query with its role
 *      (factual always; principle when the question needs a lens; dalil for
 *      fikih; sanad for hadith) — a missing one is added from a template;
 *   2. the total stays within the stage's bound, dropping the model's extra
 *      phrasings before any rule-derived one;
 *   3. every entry says where it came from, so the Trace shows a repaired set
 *      instead of passing the repair off as the model's judgment.
 *
 * Pure: same input, same sub-queries, no clock, no model, no store.
 */

/**
 * The stage's bound. The ceiling is unconditional; the floor is a floor on
 * *distinct retrieval texts*, not a promise of two entries.
 *
 * The set is 2–4 whenever two distinct texts are actually available — the
 * caller's verbatim question plus either a model sub-query that differs from
 * it or a composition rule beyond `factual`. It is **1** when the only text
 * available is the question itself: the model phrased nothing, phrased the
 * question back, or phrased nothing usable (`SubQueryReplySchema` accepts a
 * bare string, and a cheap model echoing the question is exactly what the
 * prompt's "different angles" rule is written against). Padding that case to
 * two would put a synthetic near-duplicate of the question in the trace and
 * claim a decomposition that never happened — see `decomposeQuery`'s own note.
 */
export const MIN_SUB_QUERIES = 2;
export const MAX_SUB_QUERIES = 4;

/**
 * One sub-query as the router's reader hands it over: the model's own text and
 * its claimed role, before the rules run and before any origin is assigned.
 * Owned here beside `DecompositionInput` — the consumer — and imported by the
 * reader, so the two ends of that hand-off cannot drift apart unnoticed.
 */
export type ModelSubQuery = { text: string; role?: string };

export type DecompositionInput = {
  /** The verbatim caller question — the factual sub-query's text. */
  question: string;
  needsPrinciple: boolean;
  principleTags: readonly PrincipleTag[];
  category?: SubjectArea;
  /** The model's own sub-queries, in its order. */
  modelSubQueries: readonly ModelSubQuery[];
};

/**
 * The sub-queries retrieval fans out over: the model's own, plus the ones the
 * rules require, bounded and role-labelled.
 *
 * The floor is a floor on distinct texts (see `MIN_SUB_QUERIES`): it adds the
 * caller's verbatim question — a genuinely different retrieval query from the
 * model's paraphrase, the same reason the engine carries `sourceText` — but it
 * is deduplicated like every other entry, so a model that only echoed the
 * question leaves exactly one entry rather than two spellings of one query.
 */
export function decomposeQuery(input: DecompositionInput): SubQuery[] {
  const kept: SubQuery[] = [];
  const seen = new Set<string>();

  const push = (sub: SubQuery): void => {
    // Never store an untrimmed query: a trailing space is noise in the trace
    // and makes the repair non-idempotent over its own output.
    const text = sub.text.trim();
    const key = normalize(text);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    kept.push({ ...sub, text });
  };

  for (const entry of input.modelSubQueries) {
    const role = narrowRole(entry.role);
    push({ text: entry.text, ...(role !== undefined ? { role } : {}), origin: "model" });
  }

  for (const role of requiredRoles(input)) {
    if (kept.some((sub) => sub.role === role)) continue;
    push({ text: ruleText(role, input), role, origin: "rule" });
  }

  // The floor, on distinct texts: the model phrased one sub-query and no rule
  // beyond the factual one fired (a plain factual question outside
  // fikih/hadith). The verbatim question is a genuinely different retrieval
  // query from the model's paraphrase — the same reason the engine carries
  // `sourceText` — so it is added rather than leaving the stage at a single
  // query. It runs through the same dedup as everything else: when the model's
  // only entry already *is* the question there is no second distinct text to
  // add, and one entry is the honest answer (`MIN_SUB_QUERIES`).
  if (kept.length < MIN_SUB_QUERIES) {
    push({ text: input.question.trim(), role: "factual", origin: "rule" });
  }

  if (kept.length <= MAX_SUB_QUERIES) return kept;

  // The ceiling. A plain truncation would let a reply that labelled five
  // sub-queries "factual" push the rule-derived principle one out, so the
  // budget is spent on ONE sub-query per distinct role first — the sub-queries
  // the composition rules are about — and only then on the model's extra
  // angles, in its own order. Ordering never rewrites a label, which is what
  // keeps the repair idempotent over its own output.
  const ordered = kept
    .map((sub, index) => ({ sub, index }))
    .sort((a, b) => priority(a.sub) - priority(b.sub) || a.index - b.index)
    .map((entry) => entry.sub);

  const chosen: SubQuery[] = [];
  const extras: SubQuery[] = [];
  const rolesTaken = new Set<string>();
  for (const sub of ordered) {
    if (sub.role !== undefined && !rolesTaken.has(sub.role)) {
      rolesTaken.add(sub.role);
      chosen.push(sub);
    } else {
      extras.push(sub);
    }
  }
  return [...chosen, ...extras].slice(0, MAX_SUB_QUERIES);
}

/** The composition rules that fired for this question, in priority order. */
function requiredRoles(input: DecompositionInput): SubQueryRole[] {
  const roles: SubQueryRole[] = ["factual"];
  if (input.needsPrinciple) roles.push("principle");
  if (input.category === "fikih") roles.push("dalil");
  if (input.category === "hadith") roles.push("sanad");
  return roles;
}

/**
 * The text of a rule-added sub-query. Indonesian, because the corpus's
 * fallback track and the product's prompts are Indonesian-first; the question
 * rides inside each one so the query stays about *this* question rather than
 * the rule's topic in general.
 */ function ruleText(role: SubQueryRole, input: DecompositionInput): string {
  const question = input.question.trim();
  if (role === "principle") {
    const lens = input.principleTags.length > 0 ? input.principleTags.join(", ") : "syariat";
    return `prinsip ${lens} dalam menjawab: ${question}`;
  }
  if (role === "dalil") return `dalil Al-Quran tentang: ${question}`;
  if (role === "sanad") return `sanad dan derajat hadis tentang: ${question}`;
  return question;
}

/** Rule roles rank ahead of the model's unlabelled extra angles. */
function priority(sub: SubQuery): number {
  const index = SUB_QUERY_ROLES.indexOf(sub.role as SubQueryRole);
  return index < 0 ? SUB_QUERY_ROLES.length : index;
}

/** A role outside the vocabulary is dropped, never force-matched (opaque text survives). */
function narrowRole(value: string | undefined): SubQueryRole | undefined {
  if (value === undefined) return undefined;
  return (SUB_QUERY_ROLES as readonly string[]).includes(value)
    ? (value as SubQueryRole)
    : undefined;
}

/** Duplicate detection ignores case and surrounding/repeated whitespace. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
