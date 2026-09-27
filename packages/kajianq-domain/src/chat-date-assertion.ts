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
 * Known residual limits (thermos A1/A2/A3 on #248; the strict direction is
 * deliberate, so the reverse error — rejecting a legitimate decline — is the
 * safe one):
 *
 *   - **Not detected:** a date carrying neither a year token (`tahun`/`year`
 *     + digits, or a bare number in 1000–2199) nor a recognised month name
 *     adjacent to a 1–2-digit day in either order. That covers a relative
 *     span ("dalam 100 tahun"), a spelled-out number or day ("dua belas
 *     Desember"), an unlisted month spelling or transliteration, a month name
 *     in another script, and a bare year outside 1000–2199.
 *   - **Over-strict, recorded trade (A3):** a reference-shaped number the mask
 *     does not know reads as a bare year and rejects a legitimate decline. The
 *     mask covers a verse/address `n:n`, a numbered citation `no. n`, and the
 *     kitab page references `Jilid n, Hal. n` / `Hal. n` (the product's own
 *     kitab grammar, `chat-citation-validator.ts`). The compact hadith form
 *     `HR. <collection> <n>` (no `no.`) is deliberately NOT masked: it is not
 *     one of the product's citation grammars (that validator requires
 *     `no.`), and a mask loose enough to catch it (`HR. <word> <n>`) could
 *     swallow a real date such as "HR. Ahmad menyebutkan 1447" — the one
 *     direction this file must never break. Revisit when the product grammar
 *     accepts the compact form, or when kitab ingestion widens the reference
 *     vocabulary, and extend the mask here.
 *
 * The month vocabulary is the curated literal list in this file (extend here);
 * the reference shapes masked below mirror the product's citation grammars in
 * `chat-citation-validator.ts` (SPECS §2.1 "Strict citations"). SPECS carries
 * no date vocabulary of its own.
 */

/**
 * Reference-shaped numbers, blanked before the date scan: a verse/address
 * `n:n`, a numbered citation `no. n`, and the kitab page references
 * `Jilid n, Hal. n` / `Hal. n` (the product's kitab grammar). Without this,
 * `QS. 2:255`, `HR. Bukhari no. 1950`, `Jilid 8, Hal. 1447` and `Hal. 2050`
 * would read as years (and reference numbers in the Gregorian range would
 * reject a perfectly grounded decline).
 */
const REFERENCE_NUMBER_RE =
  /\d+\s*:\s*\d+|\bno\.\s*\d+|\bJilid\s+\d+\s*,\s*Hal\.\s*\d+|\bHal\.\s*\d+/gi;

/**
 * The date-assertion grammars (both calendars): an explicit year
 * (`tahun`/`year N`), a bare year in the relevant range (1000–2199 covers
 * Gregorian 1900+ and Hijri 1300–1500), and a day + month name in either order
 * in Indonesian or English. Literal patterns, never constructed from data (the
 * non-literal-`RegExp` shape the security scan blocks). No `g` flag, so a
 * shared module-level regex carries no `lastIndex` state and detection stays
 * order-independent.
 *
 * The year-run lookahead `(?!\d)` — not a trailing `\b` — is load-bearing
 * (thermos A1): it catches a compact suffixed year (`2077M`, `1447H`,
 * `tahun2077`) while still refusing to match inside a longer digit run
 * (`12000`). `\s*` likewise catches the no-space `tahun2077`.
 *
 * The Hijri alternation is a curated spelling list a corpus actually contains
 * (thermos A2); note that `Rabi['’]?ul\s*Awal` and `Jumadil\s*Awal` also cover
 * the closed-up `Rabiulawal`/`Jumadilawal`, so no prefix-boundary `\b` can
 * hide them again.
 */
const DATE_ASSERTION_GRAMMARS: readonly RegExp[] = [
  /\btahun\s*\d{1,4}(?!\d)/i,
  /\byear\s*\d{1,4}(?!\d)/i,
  /\b(?:1\d{3}|2[01]\d{2})(?!\d)/,
  /\b\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\b/i,
  /\b(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{1,2}\b/i,
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i,
  /\b\d{1,2}\s+(?:Muharram|Muharam|Muharrom|Safar|Shafar|Sapar|Rabi['’]?ul\s*(?:Awal|Akhir|Awwal|Tsani)|Jumadil\s*(?:Awal|Akhir|Ula)|Rajab|Sya['’]?ban|Sha['’]?ban|Ramadhan|Ramadan|Romadhon|Ramadlan|Syawal|Syawwal|Shawwal|Dzulqadah|Dzulqaidah|Dzulqa['’]dah|Zulqadah|Zulqaidah|Zulkaidah|Zulkaedah|Dzulhijjah|Dzulhijah|Zulhijjah|Zulhijah)\b/i,
  /\b(?:Muharram|Muharam|Muharrom|Safar|Shafar|Sapar|Rabi['’]?ul\s*(?:Awal|Akhir|Awwal|Tsani)|Jumadil\s*(?:Awal|Akhir|Ula)|Rajab|Sya['’]?ban|Sha['’]?ban|Ramadhan|Ramadan|Romadhon|Ramadlan|Syawal|Syawwal|Shawwal|Dzulqadah|Dzulqaidah|Dzulqa['’]dah|Zulqadah|Zulqaidah|Zulkaidah|Zulkaedah|Dzulhijjah|Dzulhijah|Zulhijjah|Zulhijah)\s+\d{1,2}\b/i,
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
