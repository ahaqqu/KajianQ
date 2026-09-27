/**
 * Calendar-date assertion detection for the grounded-decline acceptance
 * (#244, owner decision 2026-09-27).
 *
 * `gs-v0-019` ("state the exact year of the Hour") exists to enforce "do not
 * assert a date for the Hour". Its acceptance now also admits a grounded
 * decline, and this module is the deterministic, domain-owned half of that
 * rule: does this answer assert a Gregorian or Hijri date? It replaces a
 * fixture-carried pattern list, because compiling a regex from data is the
 * non-literal-`RegExp` shape the Semgrep gate blocks (and the citation
 * validator's own note already forbids it) — so the vocabulary lives here as
 * literal patterns and reaches the engine as an injected function, exactly as
 * the citation grammar does.
 *
 * The direction that matters is strictness: any date-ish token rejects the
 * grounded decline, so this can never swallow a dated answer. The reverse
 * error (rejecting a legitimate decline that merely mentions a number) is
 * minimised by masking reference numbers first — a citation's own digits are
 * not date assertions.
 *
 * Known residual limit: a date expressed with no year token and no recognised
 * month name (a relative span such as "dalam 100 tahun", or a spelled-out
 * number) is not detected. The owner can extend the patterns here.
 */

/**
 * Reference-shaped numbers, blanked before the date scan: a verse/address
 * `n:n` and a numbered citation `no. n`. Without this, `QS. 2:255` and
 * `HR. Bukhari no. 1950` would read as years (and hadith numbers in the
 * Gregorian range would reject a perfectly grounded decline).
 */
const REFERENCE_NUMBER_RE = /\d+\s*:\s*\d+|\bno\.\s*\d+/gi;

/**
 * The date-assertion grammars (SPECS §2.1 date vocabulary, both calendars):
 * an explicit year (`tahun`/`year N`), a bare year in the relevant range
 * (1000–2199 covers Gregorian 1900+ and Hijri 1300–1500), and a day + month
 * name in Indonesian or English. Literal patterns, never constructed from
 * data (the non-literal-`RegExp` shape the security scan blocks). No `g` flag,
 * so a shared module-level regex carries no `lastIndex` state and detection
 * stays order-independent.
 */
const DATE_ASSERTION_GRAMMARS: readonly RegExp[] = [
  /\btahun\s+\d{1,4}\b/i,
  /\byear\s+\d{1,4}\b/i,
  /\b(?:1\d{3}|2[01]\d{2})\b/,
  /\b\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\b/i,
  /\b\d{1,2}\s+(?:Muharram|Safar|Rabiul|Rajab|Syaban|Ramadhan|Ramadan|Syawal|Dzulhijjah|Zulhijjah)\b/i,
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
];

/**
 * True when the text asserts a calendar date (Gregorian or Hijri) in any of
 * the grammars above. Reference numbers are masked first; everything else is
 * compared literally.
 */
export function assertsCalendarDate(text: string): boolean {
  const scannable = text.replace(REFERENCE_NUMBER_RE, " ");
  return DATE_ASSERTION_GRAMMARS.some((grammar) => grammar.test(scannable));
}
