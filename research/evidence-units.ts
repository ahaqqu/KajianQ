/**
 * Evidence units: the citation contract as code.
 *
 * A Golden Set requirement is one address string today, which the gate then has to read as
 * both "this evidence must be reachable" and "this exact row must be the one cited". The
 * measurement (docs/research/experiments.md, E2/E7) says those are different questions: the
 * reranker repeatedly prefers a parallel narration of the same report, and no ranking change
 * can prefer the curator's canonical choice because the corpus does not mark it.
 *
 * A unit says what the requirement actually is — one piece of evidence, one or more corpus
 * rows that carry it — and separates three relations that must never be merged: address
 * equivalence (deterministic grammar), unit membership (curated), and support (not modelled
 * here; the model tier may not gate it, experiments.md E4).
 *
 * A **unit set is one question's requirements**, not the whole Golden Set: two different
 * questions may legitimately require the same narration, so validation rejects a shared
 * address only within a single answer's unit set.
 *
 * Research artefact: not wired into the eval package.
 */

export type CitationRef = {
  /** The label the answer renders, e.g. "HR. Bukhari no. 1108". */
  readonly label: string;
  /** The address used for matching, in the same form. */
  readonly address: string;
};

export type UnitKind = "quran" | "hadith" | "tafsir" | "fiqh";

export type EvidenceUnit = {
  readonly unitId: string;
  readonly kind: UnitKind;
  /** Every row known to carry this evidence; at least one, and the canonical must be among them. */
  readonly members: readonly CitationRef[];
  /** The address a reader is shown by default when the unit is satisfied. */
  readonly canonical: CitationRef;
};

/** A row the retriever actually returned — the only thing that can satisfy a unit. */
export type RetrievedEvidence = {
  readonly address: string;
  readonly text: string;
};

export type Policy = "strict" | "equivalent";

/**
 * The address grammar: case, punctuation and spacing fold; a sub-numbered address
 * (`no. 3756.2`) folds to its parent (`no. 3756`); a range folds to its first verse.
 * Two addresses are the same requirement when their keys are equal.
 */
export function addressKey(address: string): string {
  const text = address
    .toLowerCase()
    .replace(/[.,;:()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const verse = /^qs\s*(\d+)\s+(\d+)(?:\s*[-–]\s*\d+)?/u.exec(text);
  if (verse) return `qs:${Number(verse[1])}:${Number(verse[2])}`;
  const hadith = /^hr\s+([a-z' ]+?)\s+no\s+(\d+)(?:\.\d+)?/u.exec(text);
  if (hadith) return `hr:${hadith[1].replace(/\s+/gu, "")}:${Number(hadith[2])}`;
  return text;
}

/** Every problem with a unit set, as strings a reviewer can act on. Empty means valid. */
export function validateUnits(units: readonly EvidenceUnit[]): string[] {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.unitId)) problems.push(`duplicate unitId: ${unit.unitId}`);
    ids.add(unit.unitId);
    if (unit.members.length === 0) problems.push(`${unit.unitId}: no members`);
    const keys = unit.members.map((member) => addressKey(member.address));
    if (new Set(keys).size !== keys.length)
      problems.push(`${unit.unitId}: duplicate member address`);
    if (!keys.includes(addressKey(unit.canonical.address))) {
      problems.push(`${unit.unitId}: canonical is not one of its members`);
    }
    for (const key of new Set(keys)) {
      const existing = owner.get(key);
      if (existing !== undefined && existing !== unit.unitId) {
        problems.push(`address ${key} belongs to both ${existing} and ${unit.unitId}`);
      }
      owner.set(key, unit.unitId);
    }
  }
  return problems;
}

export type UnitOutcome =
  | {
      readonly unitId: string;
      readonly satisfied: true;
      /** The member the evidence matched. */
      readonly matched: CitationRef;
      /** How it matched, so the trace can say "same unit, different address". */
      readonly relation: "canonical" | "member";
    }
  | { readonly unitId: string; readonly satisfied: false };

/**
 * Score units against retrieved evidence.
 *
 * `strict` accepts only the canonical address — today's behaviour, kept for comparison.
 * `equivalent` accepts any member and reports the relation, so a parallel narration passes
 * the requirement while the trace still shows that it was not the canonical address.
 *
 * A unit is never satisfied by evidence that was not retrieved, and unmapped evidence never
 * satisfies anything: the contract fails closed.
 */
export function scoreUnits(
  units: readonly EvidenceUnit[],
  evidence: readonly RetrievedEvidence[],
  policy: Policy,
): UnitOutcome[] {
  const available = new Set(evidence.map((row) => addressKey(row.address)));
  return units.map((unit) => {
    const canonicalKey = addressKey(unit.canonical.address);
    if (available.has(canonicalKey)) {
      return {
        unitId: unit.unitId,
        satisfied: true,
        matched: unit.canonical,
        relation: "canonical",
      };
    }
    if (policy === "equivalent") {
      const member = unit.members.find(
        (candidate) =>
          addressKey(candidate.address) !== canonicalKey &&
          available.has(addressKey(candidate.address)),
      );
      if (member !== undefined) {
        return { unitId: unit.unitId, satisfied: true, matched: member, relation: "member" };
      }
    }
    return { unitId: unit.unitId, satisfied: false };
  });
}
