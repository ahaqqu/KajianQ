import { citationSpansIn } from "./chat-citation-normalize";
import { parseHadithCitation } from "./hadith-source";
import { parseQuranCitation } from "./quran-source";

/**
 * Citation references named by a question (KajianQ domain pack, ADR-0058).
 *
 * A citation label is an **identifier**, not a topic: `HR. <collection> no. <n>`
 * names one stored passage whether or not its wording resembles the question,
 * so retrieval has to recognise the label the caller wrote and read its
 * address rather than hope dense similarity surfaces it. Detection therefore
 * uses the same grammar scan the citation gate uses — a label the question
 * spells is the label the gate will later compare — and maps each parsed
 * address onto the **metadata identity the corpus wrote at ingest**: a hadith's
 * collection and number, an ayah's surah and ayah. Those pairs are what the
 * store's generic metadata read matches; the engine never learns what they mean.
 *
 * The reference is read off the **verbatim question**, never off a router
 * sub-query, so a paraphrase cannot move it. A form whose identity is not a
 * single stored address is deliberately not resolved: a Kitab citation (not
 * ingested yet), a Quran range or a named-surah spelling this parser does not
 * resolve, and a dash-joined hadith number (the grammar keeps such a range whole
 * because it cannot enumerate it, and the gate refuses it) all yield no
 * reference — the lookup never guesses an address the label does not name.
 */

/** How many references one question may name before the lookup stops reading:
 * each costs one bounded store read, and a question naming more addresses than
 * this is not an address question. */
export const MAX_CITATION_REFERENCES = 4;

/** One named citation label and the opaque metadata pairs that address it. */
export type CitationReference = {
  /** The label as the citation grammar normalized it — the comparison form. */
  label: string;
  /** Exact-match metadata pairs the store read is keyed on; opaque to the store. */
  match: Readonly<Record<string, string | number>>;
};

/** True for a hadith number the grammar kept whole because a dash joins it to
 * another address: a declared range, which names no single stored row. */
const DASH_JOINED = /[-‐‑‒–—―−]/u;

/**
 * Every citation reference a question names, in the order it wrote them (so a
 * capped lookup spends its budget on the earliest), de-duplicated by the
 * normalized label. Candidates the citation grammars read but no corpus
 * identity backs are not returned.
 */
export function citationReferencesIn(sourceText: string): CitationReference[] {
  const references: CitationReference[] = [];
  const seen = new Set<string>();
  for (const span of citationSpansIn(sourceText)) {
    if (references.length >= MAX_CITATION_REFERENCES) break;
    if (seen.has(span.label)) continue;
    const hadith = parseHadithCitation(span.label);
    if (hadith !== null) {
      seen.add(span.label);
      if (DASH_JOINED.test(hadith.hadithNo)) continue;
      references.push({
        label: span.label,
        match: { collection: hadith.collection, hadithNo: hadith.hadithNo },
      });
      continue;
    }
    const quran = parseQuranCitation(span.label);
    if (quran !== null) {
      seen.add(span.label);
      references.push({
        label: span.label,
        match: { surah: quran.surah, ayah: quran.ayah },
      });
    }
  }
  return references;
}
