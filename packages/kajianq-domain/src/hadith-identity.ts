import { normalizeCitationLabel } from "./chat-citation-normalize";
import { parseHadithCitation } from "./hadith-source";
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
 * A group states its **relation**, and both relations are gate identities: a
 * `same-report` group is one narration through different chains, and a
 * `same-ruling` group relates different narrations that state one ruling. A
 * citation of either kind carries the required narration's identity, so the map,
 * not a single address, is the gate's unit. The relation still keeps the claim
 * honest: a reader must be able to tell whether a group says "another chain of
 * this report" or "another report of this ruling", which is why every group also
 * states its `rationale`.
 *
 * The parser is loud on a malformed map (a duplicated label, a label that is not
 * a single hadith citation, a duplicated group id, an empty group, a missing
 * relation or rationale) because a silent skip would turn a curation mistake into
 * a gate that scores differently from the map a reader sees.
 */

export type HadithIdentityRelation = "same-report" | "same-ruling";

/** The relations citation validity reads: a signed group of either relation
 * satisfies the requirement, because both name the narration or the ruling the
 * question asks for. The map is the gate's unit of identity, not one address. */
export const GATING_IDENTITY_RELATIONS: readonly HadithIdentityRelation[] = [
  "same-report",
  "same-ruling",
];

/** The relations the REPORTED identity-satisfied figure reads: the same signed
 * relations, declared separately because that figure is reported, never part of
 * `passed`, and its address comparison is the one it widens. */
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
  status: IdentityMapStatus;
  groups: readonly HadithIdentityGroup[];
};

const RELATIONS: readonly HadithIdentityRelation[] = ["same-report", "same-ruling"];

function requiredRelation(value: unknown, source: string): HadithIdentityRelation {
  if (typeof value !== "string" || !RELATIONS.includes(value as HadithIdentityRelation)) {
    throw new IdentityMapError(
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
  const record = requireRecord(input, source, ":");
  const id = requiredString(record["id"], "id", source);
  const status = requiredStatus(record["status"], source);
  const entries = requiredEntries(record, "groups", source);

  const claims = new Map<HadithIdentityRelation, ClaimRegistry>([
    ["same-report", new ClaimRegistry("same-report")],
    ["same-ruling", new ClaimRegistry("same-ruling")],
  ]);
  const groupIds = new Set<string>();
  const groups = entries.map((raw, index) => {
    const where = `${source}: groups[${index}]`;
    const group = requireRecord(raw, where);
    const groupId = requiredString(group["id"], "id", where);
    claimEntryId(groupIds, groupId, "group", where);
    const relation = requiredRelation(group["relation"], where);
    const rationale = requiredString(group["rationale"], "rationale", where);
    const canonical = requiredString(group["canonical"], "canonical", where);
    if (!isSingleHadithCitation(canonical)) {
      throw new IdentityMapError(
        `${where}: canonical "${canonical}" is not a single hadith citation`,
      );
    }
    const memberEntries = requiredEntries(group, "members", where);
    const claimed = claims.get(relation)!;
    const canonicalKey = normalizeCitationLabel(canonical);
    const claim = (label: string, field: string): string => {
      const key = normalizeCitationLabel(label);
      if (!isSingleHadithCitation(label)) {
        throw new IdentityMapError(`${where}: ${field} "${label}" is not a single hadith citation`);
      }
      claimed.claim({ key, owner: groupId, label, field, where });
      return key;
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
