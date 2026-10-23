/**
 * The scaffolding the curated identity maps share: one error type, the field
 * readers, the status gate, the duplicated-id rule and the claim registry. Each
 * map keeps the parts that decide what its entries may name — the hadith map's
 * relation set and single-citation rule, the Qur'an map's single-verse rule and
 * pair shape — while a malformed map fails the same way whichever map it is.
 */

/** Thrown when a curated identity map is malformed; the message names the field. */
export class IdentityMapError extends Error {
  override readonly name = "IdentityMapError";
}

/** The map's lifecycle: draft until the owner signs the content, like the Golden Set. */
export type IdentityMapStatus = "v0-draft" | "canonical";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The map's top-level object, or a failure naming what arrived instead. */
export function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new IdentityMapError(`${where} must be an object`);
  return value;
}

/** A required string field, trimmed; its message names the map, the entry and the field. */
export function requiredString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IdentityMapError(`${source}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/** The `v0-draft` | `canonical` status gate every map shares. */
export function requiredStatus(value: unknown, source: string): IdentityMapStatus {
  if (value !== "v0-draft" && value !== "canonical") {
    throw new IdentityMapError(`${source}: status must be "v0-draft" or "canonical"`);
  }
  return value;
}

/** A required, non-empty array field, or a failure naming it. */
export function requiredEntries(
  record: Record<string, unknown>,
  field: string,
  source: string,
): unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new IdentityMapError(`${source}: ${field} must be a non-empty array`);
  }
  return value;
}

/** Register an entry's id, or fail because another entry of the same map holds it. */
export function claimEntryId(
  ids: Set<string>,
  id: string,
  kind: "group" | "pair",
  where: string,
): void {
  if (ids.has(id)) throw new IdentityMapError(`${where}: ${kind} id "${id}" is already used`);
  ids.add(id);
}

/**
 * The labels a map's entries have claimed, within one claim scope. A claim is
 * scoped because two claims may be different — the hadith map's relations relate
 * one label two ways, while every Qur'an pair makes the same claim — so a label
 * may anchor one entry per scope and a second entry in the same scope is a
 * malformed map, not a last-one-wins.
 */
export class ClaimRegistry {
  private readonly claimed = new Map<string, string>();

  constructor(private readonly scope?: string) {}

  /** Claim `key` for `owner`, or fail naming the entry that already holds it. */
  claim(entry: { key: string; owner: string; label: string; field: string; where: string }): void {
    const previous = this.claimed.get(entry.key);
    if (previous !== undefined) {
      const scope = this.scope === undefined ? "" : ` as ${this.scope}`;
      throw new IdentityMapError(
        `${entry.where}: ${entry.field} "${entry.label}" is already claimed by "${previous}"${scope}`,
      );
    }
    this.claimed.set(entry.key, entry.owner);
  }
}
