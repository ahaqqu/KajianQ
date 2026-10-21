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
 * single stored address is deliberately not resolved — a Kitab citation (not
 * ingested yet), a Quran range or a named-surah spelling this parser does not
 * resolve, and a dash-joined hadith number (the grammar keeps such a range whole
 * because it cannot enumerate it, and the gate refuses it) all yield no
 * reference — the lookup never guesses an address the label does not name.
 *
 * **A span the scan saw but the parser did not resolve is reported, not
 * dropped silently.** "The question named no label" and "it named one the arm
 * deliberately did not resolve" are different states, and only the first may
 * leave the trace without a lookup: every unresolved span is recorded with its
 * reason ({@link DroppedCitationLabel}). The same rule covers a **continuation**
 * the grammar left outside its match — `no. 191, 192`, `no. 4697 — 4700`,
 * `no. 191 dan 192`, `no. 191 s.d. 193`. The grammar ends the span at the head
 * (a spaced range is indistinguishable from one address in its token), so the
 * parser refuses the whole form as a range or a list instead of reading the head
 * and discarding the rest.
 */

/** How many references one question may name before the lookup stops reading:
 * each costs one bounded store read, and a question naming more addresses than
 * this is not an address question. Over-budget spans are reported as unresolved
 * (`budget`), so a budget cut is never mistaken for a question with no label. */
export const MAX_CITATION_REFERENCES = 4;

/** One named citation label and the opaque metadata pairs that address it. */
export type CitationReference = {
  /** The label as the citation grammar normalized it — the comparison form. */
  label: string;
  /** Exact-match metadata pairs the store read is keyed on; opaque to the store. */
  match: Readonly<Record<string, string | number>>;
};

/** Why a citation-shaped span the scan saw maps to no single stored address:
 * `range` (the grammar keeps the dash-joined form whole, or a dash continues
 * the head), `list` (`, n` / `dan n` / `s.d. n` continues it), `collection` (a
 * hadith the corpus registry does not carry), `budget` (the fixed reference
 * budget stopped the lookup first), or `unparsed` (no parser reduces it to one
 * stored address). */
export type DroppedLabelReason = "range" | "list" | "collection" | "budget" | "unparsed";

/** One span the citation grammar saw and the lookup did not resolve. */
export type DroppedCitationLabel = {
  /** The form as the question wrote it (whitespace collapsed), so a reader can
   * see the whole range or list the head belonged to. */
  label: string;
  reason: DroppedLabelReason;
};

/** Every citation reference a question names, plus every span it named that the
 * lookup did not resolve. */
export type CitationLabelScan = {
  references: CitationReference[];
  dropped: DroppedCitationLabel[];
};

/** True for a hadith number the grammar kept whole because a dash joins it to
 * another address: a declared range, which names no single stored row. */
const DASH_JOINED = /[-‐‑‒–—―−]/u;

/** A dash-joined number anywhere in a label (the Quran range keeps its whole
 * form in one span, so the dash is not at a fixed position). */
const RANGE_SHAPED = /[-‐‑‒–—―−]\s*\p{Nd}/u;

/** A range continuation the grammar left outside its span: `— 4700`, `- 3`. */
const RANGE_CONTINUATION = /^\s*[-‐‑‒–—―−]\s*\p{Nd}+(?:\s*[-‐‑‒–—―−]\s*\p{Nd}+)*/u;

/** A list continuation the grammar left outside its span: `, 192, 193`,
 * ` dan 192`, ` s.d. 193`. */
const LIST_CONTINUATION = /^\s*(?:,\s*\p{Nd}+(?:\s*,\s*\p{Nd}+)*|(?:dan|s\.d\.)\s+\p{Nd}+)/iu;

/** The end and kind of a range/list continuation after a span, or `null` when
 * the address stands alone. A continuation is a whole form, never an endpoint. */
function continuationAfter(
  text: string,
  from: number,
): { end: number; reason: "range" | "list" } | null {
  const rest = text.slice(from);
  const range = RANGE_CONTINUATION.exec(rest);
  if (range !== null) return { end: from + range[0].length, reason: "range" };
  const list = LIST_CONTINUATION.exec(rest);
  if (list !== null) return { end: from + list[0].length, reason: "list" };
  return null;
}

/** Why a citation-shaped span no parser resolved. A hadith-shaped label whose
 * collection the registry lacks is `collection`; a dash-joined number is a
 * `range`; everything else (an un-ingested work, a named-surah spelling, a tail
 * with no address core) is `unparsed`. */
function unresolvedReason(label: string): DroppedLabelReason {
  if (/^HR[.．。]\s/u.test(label)) return "collection";
  if (RANGE_SHAPED.test(label)) return "range";
  return "unparsed";
}

/** The span as the question wrote it, whitespace collapsed: a dropped form is
 * provenance, so it keeps the range or list the head alone would hide. */
function writtenSpan(sourceText: string, start: number, end: number): string {
  return sourceText.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Every citation reference a question names, and every citation-shaped span it
 * named that maps to no single stored address. References keep the order the
 * question wrote them (so a capped lookup spends its budget on the earliest);
 * dropped spans keep it too, and neither list contains a label twice.
 */
export function citationLabelScan(sourceText: string): CitationLabelScan {
  const references: CitationReference[] = [];
  const dropped: DroppedCitationLabel[] = [];
  for (const span of citationSpansIn(sourceText)) {
    const hadith = parseHadithCitation(span.label);
    if (hadith !== null) {
      if (DASH_JOINED.test(hadith.hadithNo)) {
        dropped.push({ label: writtenSpan(sourceText, span.start, span.end), reason: "range" });
        continue;
      }
      const continuation = continuationAfter(sourceText, span.end);
      if (continuation !== null) {
        dropped.push({
          label: writtenSpan(sourceText, span.start, continuation.end),
          reason: continuation.reason,
        });
        continue;
      }
      if (references.length >= MAX_CITATION_REFERENCES) {
        dropped.push({ label: span.label, reason: "budget" });
        continue;
      }
      references.push({
        label: span.label,
        match: { collection: hadith.collection, hadithNo: hadith.hadithNo },
      });
      continue;
    }
    const quran = parseQuranCitation(span.label);
    if (quran !== null) {
      const continuation = continuationAfter(sourceText, span.end);
      if (continuation !== null) {
        dropped.push({
          label: writtenSpan(sourceText, span.start, continuation.end),
          reason: continuation.reason,
        });
        continue;
      }
      if (references.length >= MAX_CITATION_REFERENCES) {
        dropped.push({ label: span.label, reason: "budget" });
        continue;
      }
      references.push({
        label: span.label,
        match: { surah: quran.surah, ayah: quran.ayah },
      });
      continue;
    }
    dropped.push({
      label: writtenSpan(sourceText, span.start, span.end),
      reason: unresolvedReason(span.label),
    });
  }
  return { references, dropped };
}
