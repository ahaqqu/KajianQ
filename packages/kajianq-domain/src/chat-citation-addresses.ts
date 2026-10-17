/**
 * The **label-level reads** over the citation grammars: which grammar a label
 * begins with, the address it carries, whether its grammar declares an address
 * list, and every address the label names. The grammars and their patterns are
 * `chat-citation-grammar`'s; this module only asks them — split out for the
 * file-size cap, on the same terms as `chat-citation-range` (internal to the
 * domain pack, its public surface re-exported from the domain barrel through
 * `chat-citation-validator`).
 */
import { CITATION_GRAMMARS, type CitationGrammar } from "./chat-citation-grammar";

function grammarAtStart(
  label: string,
): { grammar: CitationGrammar; match: RegExpExecArray } | null {
  for (const grammar of CITATION_GRAMMARS) {
    const match = grammar.pattern().exec(label);
    if (match?.index !== 0) continue;
    return { grammar, match };
  }
  return null;
}

/**
 * The address a citation grammar identifies at the **start** of a label — the
 * head of an address list, and the read `chat-citation-reduce` reduces with.
 */
export function addressAtStart(label: string): string | null {
  const at = grammarAtStart(label);
  if (at === null) return null;
  const address = at.grammar.addressOf(at.match);
  return address !== null && address !== "" ? address : null;
}

/**
 * Whether the grammar a label **begins** with declares an address list
 * ({@link CitationGrammar.addressesOf}) — read from the grammar's own
 * structure, never inferred from the shape of the addresses {@link
 * addressesNamedBy} named. A consumer that decides a citation **per address**
 * must branch on this and on nothing else, and **this docstring is the one owner
 * of why**: the comparison site in `chat-citation-validator` points here instead
 * of restating it, and `SPECS.md` §3.7 keeps the reader-facing form.
 *
 * `false` covers both `[]` states, "no grammar at all" and "the grammar declares
 * no list": each names exactly one address and takes the extension rule.
 */
export function declaresAddressList(label: string): boolean {
  return grammarAtStart(label)?.grammar.addressesOf !== undefined;
}

/**
 * Every address the **first** citation grammar in a label names, `[]` when the
 * label begins with no grammar at all, or **`null`** when the grammar declares
 * a list it cannot enumerate. One entry for an ordinary citation; several for a
 * grammar whose form is a list ({@link CitationGrammar.addressesOf}) — the
 * Quran range, where the label is a set of addresses and grounding is decided
 * per address (ADR-0049), the range's **interior** included.
 *
 * A grammar that declares **no** list names exactly one address, and that
 * address is the label itself — not the shorter address {@link
 * CitationGrammar.addressOf} reduces it to. That keeps a consumer comparing
 * labels as **sets** honest: the hadith compound (`HR. Bukhari no. 5010—5011`)
 * names that compound, which no retrieved label equals, so
 * `HR. Bukhari no. 5010` retrieved never grounds it; a match with no address
 * core names nothing and still refuses.
 *
 * **The three states are distinct on purpose.** `[]` is "no grammar, or names
 * no address"; a non-empty list is the declared addresses; **`null` is
 * "declared, and unenumerable"**, which the caller refuses — never a
 * one-element list, the shape of a single-address declaration.
 *
 * The addresses come back in the grammar's own spelling (a range in ascending
 * ayah order); canonicalizing them for comparison belongs to
 * `chat-citation-validator`, which owns the comparison form.
 */
export function addressesNamedBy(label: string): readonly string[] | null {
  const at = grammarAtStart(label);
  if (at === null) return [];
  const declared = at.grammar.addressesOf?.(at.match);
  if (declared === null) return null;
  if (declared !== undefined) return declared.filter((address) => address !== "");
  const address = at.grammar.addressOf(at.match);
  return address === null || address === "" ? [] : [label];
}
