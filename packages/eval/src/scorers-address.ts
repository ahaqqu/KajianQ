import { requireAlternativesScope } from "./citation-alternatives";
import { requireCitationGrammar } from "./citation-grammar";
import { requireCitationIdentity, resolveIdentity } from "./citation-identity";
import type { ChunkRefLike, CitationGrammar, CitationIdentity } from "./harness-types";

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
 * `alternatives` is the curator's opt-in any-of set for the requirement the row
 * opted in: the contract permits it on a single-requirement row, and
 * {@link requireAlternativesScope} refuses a set on any other shape, so it can
 * never widen a sibling requirement. A member whose addresses were all retrieved
 * satisfies the requirement, because the curator ruled it a valid answer to the
 * question. It is a requirement-scope decision, not an identity — the members are
 * different reports, and the exact-address behavior is unchanged when no set is
 * curated.
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
  options: { grammar?: CitationGrammar; alternatives?: readonly string[] } = {},
): number {
  const { grammar, alternatives = [] } = options;
  // Guarded before the empty-required return, so a miswired grammar or a set on a
  // multi-requirement row fails typed.
  if (grammar !== undefined) requireCitationGrammar(grammar);
  requireAlternativesScope(requiredCitations, alternatives);
  if (requiredCitations.length === 0) return 1;
  const retrievedAddresses = retrievedAddressSet(retrieved, citationOf, grammar);
  const present = requiredCitations.filter((citation) =>
    [citation, ...alternatives].some((label) =>
      namesEveryRetrieved(label, retrievedAddresses, grammar),
    ),
  ).length;
  return present / requiredCitations.length;
}

/**
 * REPORTED, NEVER GATING — identity-satisfied citation-address recall: the
 * fraction of the requirements satisfied by the required address (or a curated
 * alternative's) **or by a signed identity of it**. This is the number that makes a
 * retrieval residual visible without redefining the gate: the exact metric above
 * stays what `passed` reads, and a same-ruling relation can widen this figure
 * without ever satisfying the exact address.
 *
 * An identity is consulted only through the injected resolver, and only after the
 * exact-address comparison misses; a label the map does not carry resolves to
 * `null` and matches nothing. `alternatives` behaves as in
 * {@link citationAddressRecall}.
 */
export function identitySatisfiedCitationAddressRecall(input: {
  requiredCitations: readonly string[];
  retrieved: readonly ChunkRefLike[];
  citationOf: (chunkId: string) => string | undefined;
  identity: CitationIdentity;
  grammar?: CitationGrammar;
  alternatives?: readonly string[];
}): number {
  const { requiredCitations, retrieved, citationOf, identity, grammar, alternatives = [] } = input;
  // Every guard runs before the empty-required return: a malformed resolver or a
  // set the row cannot bound is a loud failure even on a question whose citations
  // are trivially satisfied.
  if (grammar !== undefined) requireCitationGrammar(grammar);
  requireCitationIdentity(identity);
  requireAlternativesScope(requiredCitations, alternatives);
  if (requiredCitations.length === 0) return 1;
  const retrievedAddresses = retrievedAddressSet(retrieved, citationOf, grammar);
  const retrievedIdentities = new Set<string>();
  for (const chunk of retrieved) {
    const label = citationOf(chunk.id);
    if (label === undefined) continue;
    const key = resolveIdentity(identity, label);
    if (key !== null) retrievedIdentities.add(key);
  }
  const present = requiredCitations.filter((citation) => {
    const labels = [citation, ...alternatives];
    return (
      labels.some((label) => namesEveryRetrieved(label, retrievedAddresses, grammar)) ||
      labels.some((label) => {
        const key = resolveIdentity(identity, label);
        return key !== null && retrievedIdentities.has(key);
      })
    );
  }).length;
  return present / requiredCitations.length;
}

/** Every comparison-form address the retrieved chunks' labels carry. */
function retrievedAddressSet(
  retrieved: readonly ChunkRefLike[],
  citationOf: (chunkId: string) => string | undefined,
  grammar?: CitationGrammar,
): Set<string> {
  const addresses = new Set<string>();
  for (const chunk of retrieved) {
    const label = citationOf(chunk.id);
    if (label === undefined) continue;
    for (const address of comparedAddressesOf(label, grammar) ?? []) addresses.add(address);
  }
  return addresses;
}

/** Whether one label names every one of its addresses among those retrieved. */
function namesEveryRetrieved(
  label: string,
  retrievedAddresses: ReadonlySet<string>,
  grammar?: CitationGrammar,
): boolean {
  const required = comparedAddressesOf(label, grammar) ?? [];
  return required.length > 0 && required.every((address) => retrievedAddresses.has(address));
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
