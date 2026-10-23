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
 * A group states its **relation**, and the relation is what keeps the gate
 * honest: `same-report` groups are the ones citation validity may read, while
 * `same-ruling` groups relate narrations that state one instruction under
 * different chains — the reported identity-satisfied figure reads them, and the
 * exact-address gate deliberately does not. Every group also states its
 * `rationale`, because "same report" and "same ruling" are not interchangeable
 * and a reader must be able to tell which claim a group makes.
 *
 * The parser is loud on a malformed map (a duplicated label, a label that is not
 * a single hadith citation, a duplicated group id, an empty group, a missing
 * relation or rationale) because a silent skip would turn a curation mistake into
 * a gate that scores differently from the map a reader sees.
 */

export type HadithIdentityRelation = "same-report" | "same-ruling";

/** The relations the exact-address gate reads: only a signed same-report identity
 * can satisfy citation validity; a same-ruling relation never can. */
export const GATING_IDENTITY_RELATIONS: readonly HadithIdentityRelation[] = ["same-report"];

/** The relations the REPORTED identity-satisfied figure reads: the gate's plus the
 * signed same-ruling relation. Never used to compute `passed`. */
export const REPORTED_IDENTITY_RELATIONS: readonly HadithIdentityRelation[] = [
  "same-report",
  "same-ruling",
];

export type HadithIdentityGroup = {
  /** Stable group id (a narration name, not a citation). */
  id: string;
  /** Which claim the group makes: one report, or one ruling under different reports. */
  relation: HadithIdentityRelation;
  /** The group's identity key: one corpus citation label. */
  canonical: string;
  /** The corpus labels that narrate the same report or state the same ruling. */
  members: readonly string[];
  /** Why the labels are one identity (same report) or one ruling. */
  rationale: string;
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

const RELATIONS: readonly HadithIdentityRelation[] = ["same-report", "same-ruling"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HadithIdentityError(`${source}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredRelation(value: unknown, source: string): HadithIdentityRelation {
  if (typeof value !== "string" || !RELATIONS.includes(value as HadithIdentityRelation)) {
    throw new HadithIdentityError(
      `${source}: relation must be "same-report" or "same-ruling" (got ${JSON.stringify(value)})`,
    );
  }
  return value as HadithIdentityRelation;
}

/**
 * The number shape the corpus stores: one integer per (collection, number) row,
 * rendered without leading zeros. A dash-joined range (`no. 191-192`), a letter
 * glued to the number (`no. 5010a`) or a zero-padded number (`no. 0191`) names
 * more than one row, or a spelling no row carries — so it is not a single
 * citation, and a map key must be one.
 */
const CORPUS_CITATION_NUMBER = /^[1-9]\d*$/;

/** Whether a label names exactly one corpus row: a hadith citation whose number
 * has the corpus's own shape. */
function isSingleHadithCitation(label: string): boolean {
  const parsed = parseHadithCitation(label);
  return parsed !== null && CORPUS_CITATION_NUMBER.test(parsed.hadithNo);
}

/**
 * Parse an identity map from untrusted JSON. Every label must name exactly one
 * corpus row — a single hadith citation (`HR. Collection no. N`, grade
 * optional), never a dash-joined range — and a label may be claimed once per
 * relation: a same-report group and a same-ruling group may name the same label,
 * because the two claims are different, while two groups of one relation may not.
 */
export function parseHadithIdentitySet(
  input: unknown,
  source = "matn identity set",
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

  const seen = new Map<HadithIdentityRelation, Map<string, string>>([
    ["same-report", new Map()],
    ["same-ruling", new Map()],
  ]);
  const groupIds = new Set<string>();
  const groups = input["groups"].map((raw, index) => {
    const where = `${source}: groups[${index}]`;
    if (!isRecord(raw)) throw new HadithIdentityError(`${where} must be an object`);
    const groupId = requiredString(raw["id"], "id", where);
    if (groupIds.has(groupId)) {
      throw new HadithIdentityError(`${where}: group id "${groupId}" is already used`);
    }
    groupIds.add(groupId);
    const relation = requiredRelation(raw["relation"], where);
    const rationale = requiredString(raw["rationale"], "rationale", where);
    const canonical = requiredString(raw["canonical"], "canonical", where);
    if (!isSingleHadithCitation(canonical)) {
      throw new HadithIdentityError(
        `${where}: canonical "${canonical}" is not a single hadith citation`,
      );
    }
    if (!Array.isArray(raw["members"]) || raw["members"].length === 0) {
      throw new HadithIdentityError(`${where}: members must be a non-empty array`);
    }
    const claimed = seen.get(relation)!;
    const canonicalKey = normalizeCitationLabel(canonical);
    const claim = (label: string, field: string): string => {
      const key = normalizeCitationLabel(label);
      if (!isSingleHadithCitation(label)) {
        throw new HadithIdentityError(
          `${where}: ${field} "${label}" is not a single hadith citation`,
        );
      }
      const previous = claimed.get(key);
      if (previous !== undefined) {
        throw new HadithIdentityError(
          `${where}: ${field} "${label}" is already claimed by "${previous}" as ${relation}`,
        );
      }
      claimed.set(key, groupId);
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
    return { id: groupId, relation, canonical, members, rationale };
  });

  return { id, status, groups };
}

/**
 * The resolver the eval scorer consumes: a normalized citation label → the
 * identity key of the component it belongs to, or `null` when the label is in no
 * group of the requested relations. Components are the transitive union of the
 * requested relations' groups, so a label signed in both a same-report and a
 * same-ruling group shares one key with every member of both; the key is one of
 * the component's canonical labels, chosen deterministically from fixture order.
 * The null is the fail-closed state; the scorer does not guess an identity, and a
 * relation the caller did not request is not read.
 */
export function identityResolver(
  set: HadithIdentitySet,
  relations: readonly HadithIdentityRelation[],
): (label: string) => string | null {
  const groups = set.groups.filter((group) => relations.includes(group.relation));
  const parent = new Map<string, string>();
  const find = (label: string): string => {
    const root = parent.get(label);
    if (root === undefined) {
      parent.set(label, label);
      return label;
    }
    if (root === label) return label;
    const resolved = find(root);
    parent.set(label, resolved);
    return resolved;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const keyByRoot = new Map<string, string>();
  for (const group of groups) {
    const canonical = normalizeCitationLabel(group.canonical);
    for (const member of group.members) union(canonical, normalizeCitationLabel(member));
    const root = find(canonical);
    if (!keyByRoot.has(root)) keyByRoot.set(root, canonical);
  }
  return (label) => {
    const normalized = normalizeCitationLabel(label);
    if (!parent.has(normalized)) return null;
    return keyByRoot.get(find(normalized)) ?? null;
  };
}
