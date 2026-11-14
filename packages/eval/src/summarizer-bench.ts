import type { SummarizerBenchFixture, SummarizerCase } from "@app/contracts";
import type { CostRecord, Provider } from "@app/rag-core";
import { Effect } from "effect";

/**
 * Summarizer-bench case loop: the domain-agnostic measurement machinery for
 * the ingest summarizer gate. The engine owns the deterministic checks and
 * the case loop; the excerpt corpora, titles, and source keys arrive from
 * the domain pack's fixture, and the prompt construction arrives as an
 * adapter — this module never names a vendor, a model, or an Islamic source,
 * and never re-implements the production prompt.
 *
 * The gate scores what is deterministic: the prompt's own format rule
 * (sentence bounds) and faithfulness (Arabic-script tokens and numerals the
 * summary carries must ground in the excerpt, title, or source key, under
 * diacritic-stripping normalization). Theme quality is deliberately NOT
 * scored here — the report prints every summary, and that judgment stays
 * the owner's human call.
 *
 * Gate floors are the decision bench's (ADR-0042), applied per case.
 */

/** The per-case adapter the composition root supplies from the domain pack. */
export type SummarizerBenchAdapters = {
  /**
   * The production prompt builder for the case's kind: the same turns the
   * ingestion pipeline would send. The bench sends fixture text — never a
   * user's words — so the call is explicitly a non-personal-data caller
   * (ADR-0043).
   */
  buildPrompt: (c: SummarizerCase) => {
    turns: readonly { role: string; content: string }[];
    options?: Record<string, unknown>;
  };
};

/** One scored case: the asserted bounds, the summary verbatim, the verdict. */
export type SummarizerCaseOutcome = {
  caseId: string;
  language: string;
  expected: string;
  got: string;
  passed: boolean;
  cost?: CostRecord;
};

/** Strip tashkeel and unify alef/ya variants so Arabic tokens compare fairly. */
function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي");
}

const ARABIC_TOKEN = /[\u0600-\u06FF]{3,}/g;

/** Sentence segments: split on sentence punctuation or line breaks. */
function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+[\s\n]*|[\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/** The grounding corpus: excerpt lines plus the title and source key the prompt carries. */
function groundingOf(c: SummarizerCase): string {
  return normalizeArabic([c.title, c.sourceKey, ...c.excerpt].join("\n"));
}

/** Checks a summary against one case; returns a failure reason, or null when it passes. */
export function checkSummarizerCase(c: SummarizerCase, summary: string): string | null {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "empty summary";
  const sentences = sentenceCount(trimmed);
  if (sentences < c.expected.minSentences) {
    return `too few sentences (${sentences} < ${c.expected.minSentences})`;
  }
  if (sentences > c.expected.maxSentences) {
    return `too many sentences (${sentences} > ${c.expected.maxSentences})`;
  }
  if (c.expected.mustMention !== undefined) {
    const lowered = trimmed.toLowerCase();
    for (const term of c.expected.mustMention) {
      if (!lowered.includes(term.toLowerCase())) return `missing required term "${term}"`;
    }
  }
  const grounding = groundingOf(c);
  for (const token of trimmed.match(ARABIC_TOKEN) ?? []) {
    if (!grounding.includes(normalizeArabic(token))) {
      return `ungrounded Arabic token "${token}"`;
    }
  }
  for (const num of trimmed.match(/\d+/g) ?? []) {
    if (!grounding.includes(num)) return `ungrounded numeral "${num}"`;
  }
  return null;
}

/** Run one full summarizer bench through a Provider; every call's cost is surfaced. */
export async function runSummarizerBench({
  provider,
  fixture,
  adapters,
  onCost,
  onOutcome,
  wouldExceed,
  log,
}: {
  provider: Provider;
  fixture: SummarizerBenchFixture;
  adapters: SummarizerBenchAdapters;
  onCost: (cost: CostRecord) => void;
  /** Surfaced per scored case so a caller can preserve partial evidence. */
  onOutcome?: (outcome: SummarizerCaseOutcome) => void;
  wouldExceed: () => boolean;
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}): Promise<SummarizerCaseOutcome[]> {
  const outcomes: SummarizerCaseOutcome[] = [];

  for (const c of fixture.cases) {
    if (wouldExceed()) {
      log?.warn("budget cap hit — bench aborted", { caseId: c.id });
      break;
    }
    const call = adapters.buildPrompt(c);
    const result = await Effect.runPromise(
      provider.generate({
        turns: call.turns,
        // Gate fixture text is corpus/synthetic content, never a user's
        // words — the bench is explicitly a non-personal-data caller
        // (ADR-0043).
        personalData: false,
        ...(call.options !== undefined ? { options: call.options } : {}),
      }),
    );
    onCost(result.cost);
    const reason = checkSummarizerCase(c, result.text);
    const outcome: SummarizerCaseOutcome = {
      caseId: c.id,
      language: c.language,
      expected: JSON.stringify(c.expected),
      got: result.text.trim(),
      passed: reason === null,
      cost: result.cost,
    };
    outcomes.push(outcome);
    onOutcome?.(outcome);
    if (reason !== null) {
      log?.warn("case failed a deterministic check", { caseId: c.id, reason });
    }
  }

  return outcomes;
}
