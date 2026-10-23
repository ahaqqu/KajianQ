import { normalizeCitationLabel } from "./chat-citation-normalize";
import {
  ClaimRegistry,
  IdentityMapError,
  claimEntryId,
  requiredEntries,
  requiredStatus,
  requiredString,
  requireRecord,
  type IdentityMapStatus,
} from "./identity-map";
import { parseQuranCitation } from "./quran-source";

/**
 * The **curated Qur'an verse identities**: a pair names two verses that are the
 * same evidence for a question. The map exists because a verse's identity is not
 * derivable from its words: several verses carry the names ar-Rahman and ar-Rahim,
 * and only the basmalah is the pair this owner signed — so "shares both names" is
 * a rule that would admit verses the owner did not sign.
 *
 * Like the hadith map this is **gate-affecting product data**, owner-signed and
 * never inferred at query time: the eval scorer receives an opaque resolver and
 * compares keys. Each pair states its `rationale`, so the rule that makes the
 * two verses one evidence is written down with the data rather than implied by
 * a name-matching heuristic. `canonical` is the pair's key; a label outside
 * every pair has no identity and cannot match another.
 *
 * The parser is loud on a malformed map (a duplicated label, a label that is not
 * one Qur'an verse in the corpus's own spelling, a duplicated pair id, an empty
 * pair, a missing rationale) because a silent skip would turn a curation mistake
 * into a gate that scores differently from the map a reader sees.
 */

export type QuranIdentityPair = {
  /** Stable pair id (a name, not a citation). */
  id: string;
  /** The pair's identity key: one corpus verse label. */
  canonical: string;
  /** The corpus verse labels that name the same evidence. */
  members: readonly string[];
  /** Why the verses are one evidence; the rule the pair is signed under. */
  rationale: string;
};

export type QuranIdentitySet = {
  id: string;
  /** "v0-draft" until the owner signs the content off, like the Golden Set. */
  status: IdentityMapStatus;
  pairs: readonly QuranIdentityPair[];
};

/**
 * Whether a label names exactly one verse **in the corpus's own spelling**:
 * `QS. <surah>:<ayah>`, no zero padding, no grade, no range. A padded spelling
 * would be a dead key that no evidence label resolves, and a range names more
 * than one verse — neither can be a pair member.
 */
function isSingleVerse(label: string): boolean {
  const parsed = parseQuranCitation(label);
  if (parsed === null) return false;
  return normalizeCitationLabel(label) === `QS. ${parsed.surah}:${parsed.ayah}`;
}

/** Parse a Qur'an identity map from untrusted JSON. */
export function parseQuranIdentitySet(
  input: unknown,
  source = "quran identity set",
): QuranIdentitySet {
  const record = requireRecord(input, source);
  const id = requiredString(record["id"], "id", source);
  const status = requiredStatus(record["status"], source);
  const entries = requiredEntries(record, "pairs", source);

  const claims = new ClaimRegistry();
  const pairIds = new Set<string>();
  const pairs = entries.map((raw, index) => {
    const where = `${source}: pairs[${index}]`;
    const pair = requireRecord(raw, where);
    const pairId = requiredString(pair["id"], "id", where);
    claimEntryId(pairIds, pairId, "pair", where);
    const rationale = requiredString(pair["rationale"], "rationale", where);
    const canonical = requiredString(pair["canonical"], "canonical", where);
    if (!isSingleVerse(canonical)) {
      throw new IdentityMapError(`${where}: canonical "${canonical}" is not one Quran verse`);
    }
    const memberEntries = requiredEntries(pair, "members", where);
    const canonicalKey = normalizeCitationLabel(canonical);
    const claim = (label: string, field: string): void => {
      const key = normalizeCitationLabel(label);
      if (!isSingleVerse(label)) {
        throw new IdentityMapError(`${where}: ${field} "${label}" is not one Quran verse`);
      }
      claims.claim({ key, owner: pairId, label, field, where });
    };
    claim(canonical, "canonical");
    const members = memberEntries.map((member, memberIndex) => {
      const label = requiredString(member, `members[${memberIndex}]`, where);
      if (normalizeCitationLabel(label) === canonicalKey) {
        throw new IdentityMapError(`${where}: members must not repeat the canonical "${label}"`);
      }
      claim(label, "member");
      return label;
    });
    return { id: pairId, canonical, members, rationale };
  });

  return { id, status, pairs };
}

/**
 * The resolver the eval scorer consumes: a normalized verse label → its pair's
 * canonical key, or `null` when the label is in no pair. The null is the
 * fail-closed state; the scorer does not guess a verse identity.
 */
export function quranIdentityResolver(set: QuranIdentitySet): (label: string) => string | null {
  const byLabel = new Map<string, string>();
  for (const pair of set.pairs) {
    const canonical = normalizeCitationLabel(pair.canonical);
    byLabel.set(canonical, canonical);
    for (const member of pair.members) byLabel.set(normalizeCitationLabel(member), canonical);
  }
  return (label) => byLabel.get(normalizeCitationLabel(label)) ?? null;
}
