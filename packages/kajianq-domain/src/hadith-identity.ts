import { normalizeCitationLabel } from "./chat-citation-normalize";
import { parseHadithCitation } from "./hadith-source";

/**
 * The **canonical matn identities** of the hadiths the Golden Set requires. A
 * group names one narration; its members are the corpus rows that carry the same
 * report or instruction through another chain. The corpus holds one row per
 * (collection, number), so the identity a reader sees across those rows is a
 * curation fact, not a property of a citation number.
 *
 * The map is **gate-affecting product data**, not engine vocabulary: the eval
 * scorer receives a resolver built here and compares opaque keys. `canonical`
 * is the group's key and must be a corpus label; a member may be the Golden Set's
 * required label or a parallel the answer cites. A label outside every group has
 * no identity, and the scorer keeps its exact-label comparison for it — an
 * unmapped, fabricated, or unrelated citation can never resolve into a group.
 *
 * The parser is loud on a malformed map (a duplicated label, a label that is not
 * a single hadith citation, a duplicated group id, an empty group) because a
 * silent skip would turn a curation mistake into a gate that scores differently
 * from the map a reader sees.
 */

export type HadithIdentityGroup = {
  /** Stable group id (a narration name, not a citation). */
  id: string;
  /** The group's identity key: one corpus citation label. */
  canonical: string;
  /** The corpus labels that narrate the same report or instruction. */
  members: readonly string[];
};

export type HadithIdentitySet = {
  id: string;
  /** "v0-draft" until the owner signs the content off, like the Golden Set. */
  status: "v0-draft" | "canonical";
  groups: readonly HadithIdentityGroup[];
};

/** Thrown when the identity map is malformed; the message names the field. */
export class HadithIdentityError extends Error {
  override readonly name = "HadithIdentityError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HadithIdentityError(`${source}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * The number shape the corpus stores: one integer per (collection, number) row.
 * A dash-joined range (`no. 191-192`) or a letter glued to the number names
 * more than one row — or a spelling no row carries — so it is not a single
 * citation, and a map key must be one.
 */
const CORPUS_CITATION_NUMBER = /^\d+$/;

/** Whether a label names exactly one corpus row: a hadith citation whose number
 * has the corpus's own shape. */
function isSingleHadithCitation(label: string): boolean {
  const parsed = parseHadithCitation(label);
  return parsed !== null && CORPUS_CITATION_NUMBER.test(parsed.hadithNo);
}

/**
 * Parse an identity map from untrusted JSON. Every label must name exactly one
 * corpus row — a single hadith citation (`HR. Collection no. N`, grade
 * optional), never a dash-joined range — and a label and a group id may each
 * appear in one place only, across groups and inside one group.
 */
export function parseHadithIdentitySet(
  input: unknown,
  source = "hadith identity set",
): HadithIdentitySet {
  if (!isRecord(input)) throw new HadithIdentityError(`${source}: must be an object`);
  const id = requiredString(input["id"], "id", source);
  const status = input["status"];
  if (status !== "v0-draft" && status !== "canonical") {
    throw new HadithIdentityError(`${source}: status must be "v0-draft" or "canonical"`);
  }
  if (!Array.isArray(input["groups"]) || input["groups"].length === 0) {
    throw new HadithIdentityError(`${source}: groups must be a non-empty array`);
  }

  const seen = new Map<string, string>();
  const groupIds = new Set<string>();
  const groups = input["groups"].map((raw, index) => {
    const where = `${source}: groups[${index}]`;
    if (!isRecord(raw)) throw new HadithIdentityError(`${where} must be an object`);
    const groupId = requiredString(raw["id"], "id", where);
    if (groupIds.has(groupId)) {
      throw new HadithIdentityError(`${where}: group id "${groupId}" is already used`);
    }
    groupIds.add(groupId);
    const canonical = requiredString(raw["canonical"], "canonical", where);
    if (!isSingleHadithCitation(canonical)) {
      throw new HadithIdentityError(
        `${where}: canonical "${canonical}" is not a single hadith citation`,
      );
    }
    if (!Array.isArray(raw["members"]) || raw["members"].length === 0) {
      throw new HadithIdentityError(`${where}: members must be a non-empty array`);
    }
    const canonicalKey = normalizeCitationLabel(canonical);
    const claim = (label: string, field: string): string => {
      const key = normalizeCitationLabel(label);
      if (!isSingleHadithCitation(label)) {
        throw new HadithIdentityError(
          `${where}: ${field} "${label}" is not a single hadith citation`,
        );
      }
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new HadithIdentityError(
          `${where}: ${field} "${label}" is already claimed by "${previous}"`,
        );
      }
      seen.set(key, groupId);
      return key;
    };
    claim(canonical, "canonical");
    const members = raw["members"].map((member, memberIndex) => {
      const label = requiredString(member, `members[${memberIndex}]`, where);
      if (normalizeCitationLabel(label) === canonicalKey) {
        throw new HadithIdentityError(`${where}: members must not repeat the canonical "${label}"`);
      }
      claim(label, "member");
      return label;
    });
    return { id: groupId, canonical, members };
  });

  return { id, status, groups };
}

/**
 * The resolver the eval scorer consumes: a normalized citation label → its
 * group's canonical label, or `null` when the label is in no group. The null is
 * the fail-closed state; the scorer does not guess an identity.
 */
export function identityResolver(set: HadithIdentitySet): (label: string) => string | null {
  const byLabel = new Map<string, string>();
  for (const group of set.groups) {
    const canonical = normalizeCitationLabel(group.canonical);
    byLabel.set(canonical, canonical);
    for (const member of group.members) byLabel.set(normalizeCitationLabel(member), canonical);
  }
  return (label) => byLabel.get(normalizeCitationLabel(label)) ?? null;
}
