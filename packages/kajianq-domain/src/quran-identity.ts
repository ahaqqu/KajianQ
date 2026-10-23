import { normalizeCitationLabel } from "./chat-citation-normalize";
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
  status: "v0-draft" | "canonical";
  pairs: readonly QuranIdentityPair[];
};

/** Thrown when the Qur'an identity map is malformed; the message names the field. */
export class QuranIdentityError extends Error {
  override readonly name = "QuranIdentityError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new QuranIdentityError(`${source}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

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
  if (!isRecord(input)) throw new QuranIdentityError(`${source}: must be an object`);
  const id = requiredString(input["id"], "id", source);
  const status = input["status"];
  if (status !== "v0-draft" && status !== "canonical") {
    throw new QuranIdentityError(`${source}: status must be "v0-draft" or "canonical"`);
  }
  if (!Array.isArray(input["pairs"]) || input["pairs"].length === 0) {
    throw new QuranIdentityError(`${source}: pairs must be a non-empty array`);
  }

  const seen = new Map<string, string>();
  const pairIds = new Set<string>();
  const pairs = input["pairs"].map((raw, index) => {
    const where = `${source}: pairs[${index}]`;
    if (!isRecord(raw)) throw new QuranIdentityError(`${where} must be an object`);
    const pairId = requiredString(raw["id"], "id", where);
    if (pairIds.has(pairId)) {
      throw new QuranIdentityError(`${where}: pair id "${pairId}" is already used`);
    }
    pairIds.add(pairId);
    const rationale = requiredString(raw["rationale"], "rationale", where);
    const canonical = requiredString(raw["canonical"], "canonical", where);
    if (!isSingleVerse(canonical)) {
      throw new QuranIdentityError(`${where}: canonical "${canonical}" is not one Quran verse`);
    }
    if (!Array.isArray(raw["members"]) || raw["members"].length === 0) {
      throw new QuranIdentityError(`${where}: members must be a non-empty array`);
    }
    const canonicalKey = normalizeCitationLabel(canonical);
    const claim = (label: string, field: string): void => {
      const key = normalizeCitationLabel(label);
      if (!isSingleVerse(label)) {
        throw new QuranIdentityError(`${where}: ${field} "${label}" is not one Quran verse`);
      }
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new QuranIdentityError(
          `${where}: ${field} "${label}" is already claimed by "${previous}"`,
        );
      }
      seen.set(key, pairId);
    };
    claim(canonical, "canonical");
    const members = raw["members"].map((member, memberIndex) => {
      const label = requiredString(member, `members[${memberIndex}]`, where);
      if (normalizeCitationLabel(label) === canonicalKey) {
        throw new QuranIdentityError(`${where}: members must not repeat the canonical "${label}"`);
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
