/**
 * The citation grammars the product renders (SPECS §2.1), the **address each
 * grammar identifies inside its own match**, and the **addresses a match names**
 * when the form is a list rather than one address.
 *
 * A grammar's token class absorbs whatever trails the address until it meets a
 * character it excludes (whitespace, a comma, a closing bracket), and that
 * absorbed tail is not address: the footnote in `HR. Bukhari no. 5010:1`, the
 * superscript in `… no. 5010¹`, the glued grade in `… no. 5010(Sahih` and the
 * prose in `… no. 5010-ia` are one shape — characters the token took along with
 * it. Where an address ends is not decidable from the tail's characters — a
 * trailing-character rule cannot reduce `5010:1` without also eating the verse
 * digits of `QS. 2:255` — but each grammar already knows its own address, and
 * `addressOf` is where it says so. {@link addressesNamedBy} is the declaration a
 * label makes about the addresses it names, {@link declaresAddressList} is that
 * declaration's structural half, and `chat-citation-reduce` carries a
 * grammar-initial label to its comparison form.
 *
 * The split is for the file-size cap, not a new seam: this module is internal to
 * the domain pack and its public surface is re-exported from the domain barrel
 * through `chat-citation-validator`, like the rest of the citation family. Its
 * one import is `chat-citation-range`, which owns what a Quran **range** names
 * (the interior enumeration and the surah's ayah bound) — the one part of a
 * grammar's address list that is Islamic-domain data rather than grammar.
 */
import { quranRangeAddresses } from "./chat-citation-range";

export interface CitationGrammar {
  /** A fresh matcher per call (rationale on {@link CITATION_GRAMMARS}). */
  readonly pattern: () => RegExp;
  /**
   * The address inside this grammar's match, or `null` when the match carries
   * none to reduce to (a hadith number that is not ASCII-digit-led) — still a
   * citation attempt, still refused, with the lexical tail strip owning it.
   */
  readonly addressOf: (match: RegExpExecArray) => string | null;
  /**
   * Every address this grammar's match **names**, or `undefined` when the
   * grammar has no list-valued form — in which case a match names exactly the
   * one address {@link addressOf} identifies, and a dash-joined tail stays the
   * opaque compound `DASH_JOINED_NUMBER_TAIL` keeps whole — the constant
   * `chat-citation-reduce` declares.
   * Declared per grammar, not split at the comparison site: only the grammar
   * that owns an address knows whether a dash joins two of them.
   *
   * A declared list is **every** address the form names, interior included — a
   * range is not its endpoints. The Quran grammar delegates that enumeration to
   * `chat-citation-range`, which owns the surah's ayah bound.
   *
   * **`null`** is the third state: a list was declared and cannot be enumerated
   * — not `[]` ("names nothing") and not a one-element list ("names exactly this
   * one address"). A consumer must refuse it.
   */
  readonly addressesOf?: (match: RegExpExecArray) => readonly string[] | null;
  /**
   * Where the **collection name** sits inside this grammar's match, or
   * `undefined` when the form has no such slot. Declared here because the
   * grammar that owns an address owns the text inside it: a consumer that
   * rewrites the name — the comparison form's spelling fold — reads the
   * boundary from this declaration instead of re-finding it with a pattern of
   * its own at the comparison site, and the declaration reads the bounds the
   * engine recorded for that group rather than counting characters.
   */
  readonly collectionOf?: (match: RegExpExecArray) => CitationCollectionSlot | null;
}

/**
 * A collection-name slot inside one citation match: the name as the label
 * spells it, and the bounds {@link CitationGrammar.collectionOf} found it at —
 * offsets **into the text the match was found in**, so a consumer rewrites the
 * name in place and leaves the rest of the label byte-for-byte.
 */
export interface CitationCollectionSlot {
  readonly collection: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The address at the head of a hadith match's number slot: the ASCII-digit-led
 * number word — `HR. Bukhari no. 5010` out of `… no. 5010:1`, `… no. 5010¹`
 * and `… no. 5010(Sahih`. Letters and further digits continue the number
 * because they make a **different** address: `no. 5010a` and `no. 50102` must
 * never reduce to `no. 5010`, or a fabricated sub-number would ride in on a
 * retrieved one's grounding (fail-closed).
 *
 * The word is the **pattern's own third capture group**, not a second read of
 * the text: the grammar that found the match is the only writer of "where the
 * address word is". A second read would have to stay in step with the pattern by
 * hand, and a `No.` it walks past names no address — the `:1` of
 * `HR. Bukhari No. 5010:1` then refuses against the very label the chunk grounds,
 * while the comparison fold has long since folded that casing into one string.
 * The end comes from `match.indices`, which the pattern's `d` flag is what
 * publishes: nothing here counts characters, so the bound is the group's own
 * recorded coordinates. It is **positional** — a capture group added before the
 * third re-points `indices[3]` — so the validator battery is what catches that,
 * rather than a request.
 *
 * The third group is `undefined` for a token that is not ASCII-digit-led
 * (`HR. Bukhari no. abc`), the "no address to reduce to" state: the match still
 * exists, the citation is still refused, and the lexical tail strip owns it. A
 * mandatory group would delete the match instead and let such a citation past the
 * ungrounded scan unseen (fail-open).
 *
 * One exception the read shares with the fold, pinned in the validator test: a
 * letter glued to the number (`no. 5010a`) is part of the number word, so it is
 * compared as written and `…5010a` / `…5010A` are two comparison forms. The corpus
 * renders the number numerically, so the exception costs a false refusal only for
 * a label shape it never carries, and never a false ground.
 */
function hadithAddressOf(match: RegExpExecArray): string | null {
  const numberWord = match.indices?.[3];
  if (numberWord === undefined) return null;
  return match[0].slice(0, numberWord[1] - match.index);
}

/**
 * The citation grammars the product renders. Literal regexes, not strings
 * compiled on the fly: a constructed regex is the ReDoS shape the security scan
 * blocks, and there is nothing dynamic here to justify it.
 *
 * Each entry is a **factory** returning a fresh regex, because a shared
 * module-level `g` regex carries `lastIndex` state between calls — which would
 * make validation order-dependent, and a non-deterministic safety gate is no
 * gate. Extending the validator for a new source type is one addition here.
 *
 * **Digits.** Every address digit is `\p{Nd}`, so a citation written in
 * another script's decimal digits is still a citation attempt and cannot slip
 * past the gate unseen. The *fold* to the ASCII digits the corpus labels carry
 * belongs to the comparison form, not here (`chat-citation-validator` folds the
 * fullwidth block, the one `\p{Nd}` block that is a rendering variant of
 * ASCII). Every other block therefore stays unfolded and **refuses**: it is
 * recognised, and no retrieved ASCII label grounds it — the fail-closed
 * direction this gate defaults to. The hadith number is stricter still: its
 * address is ASCII-digit-led, and a number in another script has no address
 * core at all, so the lexical tail rule owns it and it likewise refuses.
 */
// Hadith: `HR. Bukhari no. 573` / `HR. Ibn Majah no. 224 (Dhaif)`, and the
// dot-less `HR Bukhari no. 573` (same rationale as the Quran marker).
// Collection names may be multi-word ("Abu Dawud", "Ibn Majah") and
// the long forms a model actually writes carry a collection-type prefix
// ("Sunan Abu Dawud", "Sunan an Nasai"), so up to four tokens are tolerated.
// Token classes exclude `.` and `,` so the match cannot run across a sentence
// boundary or swallow a list, and both the token length and the repetition
// count are bounded — no nested unbounded quantifier, so the pattern stays
// linear (ReDoS-safe) as required. The trailing number token also skips
// brackets: `[HR. Malik no. 18]` must not capture a phantom `…no. 18]` span
// that normalized to nothing a chunk grounds — a false UNGROUNDED, i.e. a
// refused grounded answer; the Quran address already skipped them. The match
// therefore spans address + absorbed tail; the pattern's second group is that
// tail and its third is the address's number word — `hadithAddressOf` reads the
// address end off the third group's recorded bounds rather than searching the
// text for the address word a second time.
//
// That trailing token **stops before a following hadith marker**, because the
// scan resumes after the whole match: a token that ran across
// `… no. 224”和“HR. Muslim no. 224` would take the second `HR` with it, and the
// next citation would never be scanned at all — a fabricated address delivered
// unjudged, the fail-open direction this gate exists to close. The stop is a
// constant-size lookahead per consumed character, and it can only shorten a
// **non-address** tail: the number word is read before it and the address end
// comes from the recorded bounds, so the address a digit-led match reduces to
// does not move. A marker glued to a word character (`42HR. Muslim no. 224`,
// `… no. 224xHR. Muslim no. 224`) is not a marker to this grammar — the
// pattern's own `\b` is read from the character before it wherever the scan
// starts — so it is absorbed by whichever token it sits in. In the number word
// or the collection group the merged token is a different address, which
// refuses; in the tail the first address stays intact and the marker is
// invisible, the recorded boundary the scan documents.
//
// A **spaced** joiner stays outside this token — `HR. Bukhari no.
// 5010 - 5011` scans as its head — a recorded exclusion (ADR-0049's "Hadith
// ranges" revisit trigger), pinned as deliberate in the validator test. The
// collection is the first **capture group**, so a consumer rewriting the name
// reads it out of the match the scan made rather than finding it again.
const HADITH_GRAMMAR: CitationGrammar = {
  // The tail is one run of token characters, split into the number word and the
  // remainder that run absorbs: the lookahead is what keeps it non-empty (it
  // consumes nothing), and the number word is the optional group after it —
  // optional so a token that is not digit-led still MATCHES, with no address for
  // `hadithAddressOf` to name. The remainder's own lookahead stops it before a
  // marker this grammar would match, so the scan re-enters on that marker
  // instead of skipping past it inside the tail.
  //
  // The marker is spelled **twice** — at the start and in the tail stop —
  // because the house rule is a literal regex (a constructed one is the ReDoS
  // shape the security scan blocks). The two spellings are one rule: the
  // validator test pins them as identical, so widening the start without
  // widening the stop reddens it instead of reopening the fail-open the stop
  // closes.
  pattern: () =>
    /\bHR(?:\.|\s)\s*([^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3})(\s+no\.\s*(?=[^\s,;.)[\]])(\d[\p{L}\p{Nd}]*)?(?:(?!\bHR(?:\.|\s))[^\s,;.)[\]])*)/dgiu,
  addressOf: (match) => hadithAddressOf(match),
  collectionOf: (match) => hadithCollectionSlot(match),
};

/**
 * {@link CitationGrammar.collectionOf} for the hadith grammar: the name is the
 * pattern's own first capture group, and its bounds are the ones the engine
 * recorded for that group — `match.indices`, which the pattern's `d` flag is what
 * publishes, in the same coordinates as the text the scan read. Nothing here counts characters, so the bounds cannot drift when the
 * pattern gains a group: they are the group's own coordinates, not a
 * reconstruction of them.
 *
 * A pattern without `d` publishes no indices at all. That state is **loud under
 * test, never silent in a request**: the slot is absent, the fold declines to
 * guess, and the spelling the grammar read stops folding onto the corpus's label —
 * a false ungrounded, which the collection and replay battery fails on. The
 * grammar still scans, so the citation itself is not lost.
 */
function hadithCollectionSlot(match: RegExpExecArray): CitationCollectionSlot | null {
  const collection = match[1];
  const bounds = match.indices?.[1];
  if (collection === undefined || bounds === undefined) return null;
  return { collection, start: bounds[0], end: bounds[1] };
}

/**
 * Rewrite the collection name of **every** hadith address a text carries,
 * through `fold`. Every occurrence, never only the first: a comparison form that
 * folded one position would stop preserving containment — a label inside a
 * longer text would no longer be findable in that text's comparison form — and
 * the grounded-label passes read a whole answer that way.
 */
export function rewriteHadithCollections(
  text: string,
  fold: (collection: string) => string,
): string {
  let rewritten = "";
  let cursor = 0;
  for (const match of text.matchAll(HADITH_GRAMMAR.pattern())) {
    const slot = HADITH_GRAMMAR.collectionOf?.(match);
    if (slot === undefined || slot === null) continue;
    rewritten += text.slice(cursor, slot.start) + fold(slot.collection);
    cursor = slot.end;
  }
  return cursor === 0 ? text : rewritten + text.slice(cursor);
}

export const CITATION_GRAMMARS: readonly CitationGrammar[] = [
  // Quran: `QS. 2:255` / `Q.S. 2:255` (both dotted spellings Indonesian prose
  // uses) or `QS. Al-Baqarah:255` (surah numeric or named). The marker closes
  // with a dot OR a space: the dot-less `QS 2:255` is a common model spelling,
  // and requiring the dot would let a fabricated citation bypass the gate
  // entirely. Requiring *some* separator keeps `QS2:255` (no boundary between
  // marker and address) out of the grammar — `canonicalizeCitationSpelling`
  // mirrors that exclusion, so the fold never rewrites a spelling this scan
  // cannot see. The match spans address + absorbed tail: it takes the WHOLE
  // dash-joined chain with it (`QS. 2:255—256`, `QS. 3:1-2-3`), so the shared
  // `DASH_JOINED_NUMBER_TAIL` rule keeps the compound whole exactly as it does
  // for the hadith number — and the chain is one group, not a repeated
  // capture, because a repeated group would hand `addressesOf` only its last
  // iteration and let every earlier number ride in un-named. The
  // **capture group** is the `surah:ayah` head inside that match — the colon
  // and both numbers of `QS. 2:255` stay address, never tail. The dash tail
  // tolerates `\p{Cf}` on either side of the dash: the hadith token absorbs that
  // glue and keeps its compound, but this pattern is structured, so without that
  // tolerance it stops at the glue and grounds `QS. 2:255\u200c—256` on the
  // first verse alone. Only those two positions need it — glue inside either
  // number truncates the match and the compound is kept whole and refused. The
  // chain also tolerates **horizontal whitespace** around the dash: `QS. 2:255
  // - 256` is the same range with air around the joiner, and a glued-only dash
  // would stop the scan at the head — the second verse neither enumerated nor
  // refused. One verdict for both spellings also needs the span to be
  // ENUMERABLE — an unenumerable range refuses in both, the `null` state of
  // `addressesOf`. A newline is deliberately not tolerated, so a chain never
  // runs across a line boundary. The chain group is linear: every iteration
  // consumes a mandatory dash and at least one digit, and digits are neither
  // `\p{Cf}`, whitespace nor a dash, so no input splits an iteration two ways.
  {
    pattern: () =>
      /(\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\p{Nd}+)((?:[\p{Cf} \t]*[-‐‑‒–—―−][\p{Cf} \t]*\p{Nd}+)*)/giu,
    addressOf: (match) => match[1] ?? null,
    // A Quran range is a LIST of addresses, and the grammar is where that is
    // declared (ADR-0049): `QS. 3:1-2` names `QS. 3:1` **and** `QS. 3:2`, so
    // the comparison form can require every one of them present while the
    // display form stays the range as written. The list is every address the
    // range names — the interior included, bounded by the surah's own ayah
    // count (`chat-citation-range`) — and the second member reuses the head's
    // surah, the grammar's address being `surah:ayah`, so the tail numbers are
    // verses of the SAME surah (a named surah included:
    // `QS. Al-Baqarah:255—256`, which is unverifiable and refuses anyway).
    addressesOf: (match) => quranRangeAddresses(match[1], match[2]),
  },
  // Hadith — declared above with its collection slot, which {@link
  // rewriteHadithCollections} reads.
  HADITH_GRAMMAR,
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition — detecting it is the point, not an accident. The match IS
  // the address; the work and author the label carries precede it.
  {
    pattern: () => /\bJilid\s+\p{Nd}+\s*,\s*Hal\.\s*\p{Nd}+/giu,
    addressOf: (match) => match[0],
  },
];
