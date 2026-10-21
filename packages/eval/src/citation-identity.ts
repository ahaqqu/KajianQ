import type { CitationIdentity } from "./harness-types";

/**
 * The scorer's guard on the injected identity resolver. The resolver comes from
 * a composition root that may be plain JavaScript, and the scorer compares its
 * answers with `===`: a resolver that returns `undefined` or a non-string would
 * make two uncurated labels look like the same identity, and the gate would
 * accept an unrelated citation. A malformed resolver is a loud failure, never
 * a fallback to the exact-label path.
 */
export class CitationIdentityError extends Error {
  readonly kind = "citation_identity_malformed";

  constructor(message: string) {
    super(message);
    this.name = "CitationIdentityError";
  }
}

/** Throw unless the resolver exposes the one member the scorer calls. */
export function requireCitationIdentity(identity: CitationIdentity): void {
  if (typeof identity.identityOf !== "function") {
    throw new CitationIdentityError("citation identity resolver must expose identityOf(label)");
  }
}

/** Resolve one label, enforcing the `string | null` contract at the boundary
 * where a JavaScript resolver can break it. */
export function resolveIdentity(identity: CitationIdentity, label: string): string | null {
  const key = identity.identityOf(label);
  if (key === null) return null;
  if (typeof key !== "string" || key.trim() === "") {
    throw new CitationIdentityError(
      `citation identity resolver returned ${typeof key} for "${label}"; expected a non-empty string or null`,
    );
  }
  return key;
}
