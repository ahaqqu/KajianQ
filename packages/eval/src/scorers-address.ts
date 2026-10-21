import { requireCitationGrammar } from "./citation-grammar";
import type { ChunkRefLike, CitationGrammar } from "./harness-types";

/**
 * Citation-address recall: the fraction of the question's required citations
 * whose **specific address** the retrieval event's chunks carry — the metric
 * source-type recall cannot see. Every entry of `requiredCitations` is required;
 * an empty list scores 1.
 *
 * The chunk ids on the trace are joined to their `citation` metadata by the
 * caller's `citationOf`. Each label is read as the addresses it names (a range
 * names every verse in it) in the injected grammar's normalized form, so the
 * fixture's and the corpus's spelling of one address compare equal; an
 * unenumerable required citation is a miss, never a guess. Deliberately not
 * satisfied by a citation identity: recall asks for the exact address, so a
 * parallel narration that may satisfy citation validity does not count here.
 *
 * The comparison form is many-to-one where the grammar treats two spellings as
 * one address: a grade written into a requirement is not the address, a
 * `.`-sub-number (`… no. 3756.2`) folds into its head (`… no. 3756`), and so does
 * a spaced tail (`… no. 191 a`). The fold is the gate's own, not this metric's.
 */
export function citationAddressRecall(
  requiredCitations: readonly string[],
  retrieved: readonly ChunkRefLike[],
  citationOf: (chunkId: string) => string | undefined,
  grammar?: CitationGrammar,
): number {
  // Guarded before the empty-required return, so a miswired grammar fails typed.
  if (grammar !== undefined) requireCitationGrammar(grammar);
  if (requiredCitations.length === 0) return 1;
  const retrievedAddresses = new Set<string>();
  for (const chunk of retrieved) {
    const label = citationOf(chunk.id);
    if (label === undefined) continue;
    for (const address of comparedAddressesOf(label, grammar) ?? []) {
      retrievedAddresses.add(address);
    }
  }
  const present = requiredCitations.filter((citation) => {
    const required = comparedAddressesOf(citation, grammar) ?? [];
    return required.length > 0 && required.every((address) => retrievedAddresses.has(address));
  }).length;
  return present / requiredCitations.length;
}

/** The comparison-form addresses one label names through the injected grammar;
 * `null` is "declared, and unenumerable", which names nothing. With no grammar
 * the label itself is the one address. */
export function comparedAddressesOf(
  label: string,
  grammar?: CitationGrammar,
): readonly string[] | null {
  if (grammar === undefined) return [label];
  const declared = grammar.addressesNamedBy(label);
  if (declared === null) return null;
  return (declared.length > 0 ? declared : [label]).map(grammar.normalizeLabel);
}
