import { SURAH_AYAH_COUNTS } from "./surah-names";

/**
 * The addresses a Quran **range** names (ADR-0049, #274; review A2 of the fix
 * round).
 *
 * The gate's rule is strict-whole — a citation that names a list of addresses
 * grounds only when **every** address it names is in the retrieved context —
 * so "which addresses does this range name" must be answered the way a reader
 * answers it, not from the numbers the writer happened to type. `QS. 2:255-260`
 * names 255 through 260: the interior is what makes a range a range, and
 * enumerating only its endpoints grounds a citation on two retrieved verses
 * while four it names were never retrieved. That endpoint-pair reading is the
 * hole this module closes; the ADR's own sentence ("every address it names") is
 * now what the code does.
 *
 * Three properties are load-bearing:
 *
 * - **Bounded by the surah's own Tanzil ayah count.** The counts are the domain
 *   pack's static table (`SURAH_AYAH_COUNTS`, the same data
 *   `detectSurahReference` validates an explicit address against), so a span
 *   can never enumerate more addresses than the surah has. A surah written by
 *   **name** has no number to look up, so it is bounded by the longest surah
 *   instead — and its addresses are unverifiable against the corpus's numeric
 *   labels anyway, so that form refuses whatever the bound. Only the surah's
 *   bound is ever read here: this module learns nothing about what a chunk
 *   contains, and it is given the grammar's captures, not the draft.
 * - **The interior, and every number a chain writes.** One rule reads both
 *   shapes: the numbers are collected — the head's ayah then each dash-joined
 *   number — and the whole span from the smallest to the largest is named. So
 *   `QS. 2:255-260` names its four interior verses, and `QS. 3:1-2-3` names
 *   3:1, 3:2 **and** 3:3 instead of letting the trailing `-3` ride in un-named
 *   on a scanned `QS. 3:1-2` (the second half of review A2).
 * - **Fail-closed on anything it cannot enumerate.** An ayah the surah cannot
 *   have (`QS. 2:1-999`, `QS. 2:0-5`), a surah number outside the table, a
 *   number written in another script's digits (the digit posture refuses those
 *   at the comparison site): a list that cannot be enumerated is a list the
 *   gate **cannot verify**, so the citation must refuse rather than ground on a
 *   shorter reading of it.
 *
 *   That refusal is returned as **`null`** — the third state of the naming
 *   declaration, not a list at all (review T1 of the fix round). It used to be
 *   encoded as the label itself in a **one-element list**, and that encoding
 *   was indistinguishable from "this grammar declares a single address": both
 *   reached the comparison site as `[label]`, so the per-address rule skipped
 *   the unenumerable span and the shortened-label rule grounded it on its head.
 *   The spaced form was therefore weaker than its glued twin at exactly the
 *   address ADR-0049 names as the refusal case — `QS. 2:255 - 999` grounded on
 *   `QS. 2:255` while `QS. 2:255-999` refused. `null` carries the one meaning a
 *   list cannot ("declared, and unverifiable"), and `addressesNamedBy` passes it
 *   through so the refusal is decided where the declaration is read.
 *
 *   Returning the written numbers instead would make the refusal depend on the
 *   impossible member being absent from a corpus that is supposed to hold only
 *   Tanzil-valid addresses: true today, but a refusal that rests on corpus
 *   purity is not a refusal a safety gate may rest on.
 */

/**
 * The grammar's head shape, re-read here: `QS. 3:1`, `Q.S. 2:255`, `QS 2:255`,
 * `QS. Al-Baqarah:255`. Both numbers are ASCII-decimal: a head written in
 * another script's digits is recognised by the grammar but not enumerable, so
 * it takes the fail-closed path. Literal, and anchored at both ends, so the
 * head the grammar captured is the whole match or nothing.
 */
const RANGE_HEAD = /Q\.?S(?:\.|\s)\s*([^\s:,[\]()]+)\s*:\s*(\d+)\s*$/iu;

/** The longest surah's ayah count — the bound when the surah is written by name. */
const LONGEST_SURAH = Math.max(...SURAH_AYAH_COUNTS);

/** Replace the head's ayah with another, keeping the surah exactly as written. */
function withAyah(head: string, ayah: string): string {
  return head.replace(/:\s*\p{Nd}+$/u, `:${ayah}`);
}

/**
 * The ayah bound for a surah token: its Tanzil count, the longest surah's when
 * the token is a name, or `null` when it is a number the table does not hold
 * (an impossible surah, which refuses like any other unenumerable list).
 */
function boundFor(surahToken: string): number | null {
  const surah = Number(surahToken);
  if (!Number.isInteger(surah)) return LONGEST_SURAH;
  return SURAH_AYAH_COUNTS[surah - 1] ?? null;
}

/**
 * Every address the Quran grammar's match names: the range's whole span in
 * ascending ayah order, `[head]` for a single address (no chain), or **`null`**
 * when the form declares a list it cannot enumerate.
 *
 * `null` is the fail-closed signal documented above and is deliberately not a
 * list: a one-element list means "this form names exactly this one address"
 * (the ordinary single address, and a grammar that declares no list at all),
 * so encoding an unverifiable range that way made the two meanings
 * indistinguishable at the comparison site and let a spaced, unenumerable range
 * ground on its head (review T1 of the fix round).
 *
 * `head` and `chain` are the grammar's two captures — the `surah:ayah` head and
 * the raw dash-joined tail (`-2`, `-2-3`, `—256`), empty when the citation is a
 * single address. A single address comes back as itself, so a caller can
 * compare labels as sets without special-casing the ordinary form.
 */
export function quranRangeAddresses(
  head: string | undefined,
  chain: string | undefined,
  label: string,
): readonly string[] | null {
  if (head === undefined || head === "") return [];
  const tails = (chain ?? "").match(/\p{Nd}+/gu) ?? [];
  if (tails.length === 0) return [head];
  const parsed = RANGE_HEAD.exec(head);
  const ayah = parsed?.[2] === undefined ? Number.NaN : Number(parsed[2]);
  const bound = parsed?.[1] === undefined ? null : boundFor(parsed[1]);
  if (bound === null || !Number.isInteger(ayah)) return null;
  let low = ayah;
  let high = ayah;
  for (const tail of tails) {
    const n = Number(tail);
    if (!Number.isInteger(n)) return null;
    if (n < low) low = n;
    if (n > high) high = n;
  }
  // An address the surah cannot have makes the span unenumerable as a set of
  // real addresses, and an unverifiable list refuses (never a shorter reading).
  if (low < 1 || high > bound) return null;
  const named: string[] = [];
  for (let n = low; n <= high; n += 1) named.push(withAyah(head, String(n)));
  return named;
}
