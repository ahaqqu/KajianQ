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
 *      fikih; sanad for hadith) — a missing one is added from a template, and
 *      when that rule's text is already in the set under no role of its own
 *      (the model echoed the question, or labelled it outside the vocabulary)
 *      the rule's role is stamped onto that entry instead of a duplicate text
 *      being added, so the duplicate filter never costs a rule its coverage
 *      (review R2-A1). One exception, because the model's label is never
 *      overwritten: an entry that already carries a *different* declared role
 *      keeps it, and that rule's coverage is not shown;
 *   2. every entry is trimmed, and a text the reply phrased with no letter and
 *      no digit in any script — whitespace, punctuation, an emoji, a control
 *      character — is dropped rather than embedded: it cannot retrieve, and it
 *      would spend an embed slot and a pair of searches inside the ceiling's
 *      window where a real angle belongs (#450). The rules' own texts are the
 *      caller's question and templates built on it, never the reply's claim, so
 *      the drop is the reply's alone;
 *   3. the total stays within the stage's bound, dropping the model's extra
 *      phrasings before any rule-derived one — and never the entry a fired
 *      rule's own text lives in, which is that rule's coverage;
 *   4. every entry says where it came from, so the Trace shows a repaired set
 *      instead of passing the repair off as the model's judgment.
 *
 * Pure: same input, same sub-queries, no clock, no model, no store — and the
 * same sub-queries again when its own output is fed back in as the model's
 * reply, which is what the property suite's idempotence law asserts.
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
 * It is **0** when there is nothing to search at all: a blank question (whose
 * rule text is blank, and which `push` drops) and a reply whose every text
 * was dropped for carrying no letter and no digit.
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
  const firedRoles = requiredRoles(input);

  const push = (sub: SubQuery): void => {
    // Never store an untrimmed query: a trailing space is noise in the trace
    // and makes the repair non-idempotent over its own output.
    const text = sub.text.trim();
    const key = normalize(text);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    kept.push({ ...sub, text });
  };

  // The texts the rules below will add, keyed the way the duplicate filter keys
  // them — one concept, derived once, so the reply's filter, the rule loop and
  // the ceiling's stand-in protection cannot drift apart. One of them is the
  // caller's own question — the `factual` rule's text, and the floor's — which
  // is what the exception in the reply's filter is for.
  const ruleTexts = new Map<SubQueryRole, string>(
    firedRoles.map((role): [SubQueryRole, string] => [role, ruleText(role, input)]),
  );
  const ruleTextKeys = new Set([...ruleTexts.values()].map((text) => normalize(text)));

  for (const entry of input.modelSubQueries) {
    const role = narrowRole(entry.role);
    // The reply's text is a claim this repair may drop. Drop one carrying
    // nothing to search with — no letter and no digit in any script: whitespace,
    // punctuation, an emoji, a control character. It cannot retrieve (the
    // sparse track tokenizes nothing out of it, the dense track returns its
    // nearest neighbours to noise), and below the ceiling it would spend an
    // embed slot and a pair of searches where a rule's or a real angle's query
    // belongs (#450). The one text it may not drop is one a fired rule adds
    // back anyway: the reply echoing the caller's question is that rule's own
    // text, and dropping it here would only move it down the fan-out when the
    // rule re-adds it — the re-ordering that made the idempotence law's verdict
    // depend on the seed. Trimming is not a drop: padded text is the same
    // query, so it is kept, trimmed.
    if (!hasSearchableContent(entry.text) && !ruleTextKeys.has(normalize(entry.text))) continue;
    push({ text: entry.text, ...(role !== undefined ? { role } : {}), origin: "model" });
  }

  for (const [role, text] of ruleTexts) {
    if (kept.some((sub) => sub.role === role)) continue;
    // The rule's text may already be in the set — most often `factual`, whose
    // text *is* the caller's question, which the model may have echoed. Adding
    // it would put one retrieval text in twice (two embed slots for one
    // search); dropping it would leave the fired rule uncovered and the Trace
    // unable to explain the route. So when the entry carrying that text has no
    // role of its own — the model gave none, or gave one the vocabulary drops —
    // the rule's role is stamped onto it: the text stays the model's phrasing
    // and keeps its `model` origin, and the rule's coverage becomes visible
    // (review R2-A1). An entry the model labelled with a *different* declared
    // role keeps that label — overwriting it would pass the rule's role off as
    // the model's own — so that coincidence stays the exception the header
    // states.
    const holder = kept.find(
      (sub) => sub.role === undefined && normalize(sub.text) === normalize(text),
    );
    if (holder !== undefined) {
      holder.role = role;
      continue;
    }
    push({ text, role, origin: "rule" });
  }

  // The floor, on distinct texts: the model phrased one sub-query and no rule
  // beyond the factual one fired (a plain factual question outside
  // fikih/hadith). The verbatim question is a genuinely different retrieval
  // query from the model's paraphrase — the same reason the engine carries
  // `sourceText` — so it is added rather than leaving the stage at a single
  // query. It runs through the same dedup as everything else: when the model's
  // only entry already *is* the question there is no second distinct text to
  // add, and one entry is the honest answer (`MIN_SUB_QUERIES`). It is the
  // caller's own text, so it is never dropped for carrying no letter or digit —
  // only a blank question has no query in it at all, and then the floor adds
  // nothing.
  if (kept.length < MIN_SUB_QUERIES) {
    push({ text: input.question.trim(), role: "factual", origin: "rule" });
  }

  if (kept.length <= MAX_SUB_QUERIES) return kept;

  // A fired rule is covered in one of two ways: an entry carries its role, or
  // — the header's one stated exception — the model labelled the rule's own
  // text with a different declared role, and that entry is the rule's only
  // evidence. The first kind already has a slot the ceiling owes it (one per
  // distinct role below); the second kind is what `standInKeys` protects. Drop
  // it and the set loses the rule's text *and* the rule's role at once, so
  // feeding the repair its own output would re-add the rule's entry and change
  // the answer — the exact way the idempotence law failed (#450). One text
  // appears at most once, so at most one entry stands in for a given rule. The
  // bound this argument gives — `chosen` ≤ `MAX_SUB_QUERIES`, so the slice never
  // cuts a stand-in — is a checked invariant, not prose: the law `keeps a fired
  // rule's own text when the rule is left uncovered` runs it over both
  // generators in `chat-router-decompose.prop.test.ts`.
  const standInKeys = new Set(
    [...ruleTexts]
      .filter(([role]) => !kept.some((sub) => sub.role === role))
      .map(([, text]) => normalize(text)),
  );

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
    const { role } = sub;
    // One entry per distinct role first: that is the slot the ceiling owes a
    // fired rule's coverage.
    if (role !== undefined && !rolesTaken.has(role)) {
      rolesTaken.add(role);
      chosen.push(sub);
      continue;
    }
    // A rule's stand-in takes a slot of its own, ahead of the extras: it is
    // what keeps a fired rule's coverage and the text that carries it.
    if (standInKeys.has(normalize(sub.text))) chosen.push(sub);
    else extras.push(sub);
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

/**
 * Does this text carry anything a search can match? A letter or a digit in any
 * script — `\p{L}` and `\p{N}` are Unicode properties, so Arabic, Jawi, a bare
 * numeral and a single word all count. Anything else (whitespace, punctuation,
 * emoji, control characters) is not a query: the sparse track would tokenize
 * nothing from it and the dense track would return its nearest neighbours to
 * noise, at the price of an embed and a pair of searches (#450).
 */
function hasSearchableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
