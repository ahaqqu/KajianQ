import type { SummarizerCase } from "@app/contracts";

/** Strip tashkeel and unify alef/ya variants so Arabic tokens compare fairly. */
function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي");
}

const ARABIC_TOKEN = /[\u0600-\u06FF]{3,}/g;

/**
 * The summarizer bench's faithfulness read for this corpus: every
 * Arabic-script token a summary carries must ground in the case's excerpt,
 * title, or source key, compared under the fold above so a diacritic or
 * orthographic variant of the same word still grounds. Returns one reason per
 * ungrounded token; an empty list means the summary's Arabic content is
 * grounded.
 */
export function ungroundedArabicTokens(c: SummarizerCase, summary: string): string[] {
  const grounding = normalizeArabic([c.title, c.sourceKey, ...c.excerpt].join("\n"));
  const reasons: string[] = [];
  for (const token of summary.match(ARABIC_TOKEN) ?? []) {
    if (!grounding.includes(normalizeArabic(token))) {
      reasons.push(`ungrounded Arabic token "${token}"`);
    }
  }
  return reasons;
}
