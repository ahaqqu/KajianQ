import { readFileSync } from "node:fs";
import { citationIdentityResolver } from "./citation-identity";
import {
  GATING_IDENTITY_RELATIONS,
  REPORTED_IDENTITY_RELATIONS,
  parseHadithIdentitySet,
  type HadithIdentityGroup,
} from "./hadith-identity";
import { parseQuranIdentitySet } from "./quran-identity";

/**
 * The two resolvers the engine's eval scorer reads, built from the domain pack's
 * own owner-signed fixtures. One loader serves every composition root, so the
 * staging harness and the tests that verify the instruments against the curated
 * data cannot drift about which maps are loaded or which relation each mode reads.
 *
 * `gating` is citation validity's resolver: the signed hadith groups of both
 * relations plus the curated verse pairs, because a report's parallel chain and
 * a different report of its ruling are both the identity the question asks for.
 * `reported` is the identity-satisfied figure's resolver: the same relations,
 * read to widen the address comparison the gate keeps exact. The engine compares
 * the opaque keys; the relation vocabulary and the citation grammar stay here, in
 * the domain pack.
 *
 * The maps are read on call, not at import: a process that never scores pays no
 * file read, and a malformed fixture fails at the call that needed it.
 */
export type CuratedIdentityResolvers = {
  gating: { identityOf: (label: string) => string | null };
  reported: { identityOf: (label: string) => string | null };
  /** The parsed matn-identity map's groups, so a consumer that must account for
   * every relation reads the same parse the resolvers are built from. */
  groups: readonly HadithIdentityGroup[];
};

const HADITH_FIXTURE = new URL("../fixtures/hadith-identities-v0.json", import.meta.url);
const QURAN_FIXTURE = new URL("../fixtures/quran-identities-v0.json", import.meta.url);

export function curatedIdentityResolvers(): CuratedIdentityResolvers {
  const hadith = parseHadithIdentitySet(
    JSON.parse(readFileSync(HADITH_FIXTURE, "utf8")),
    "hadith-identities-v0",
  );
  const quran = parseQuranIdentitySet(
    JSON.parse(readFileSync(QURAN_FIXTURE, "utf8")),
    "quran-identities-v0",
  );
  return {
    gating: { identityOf: citationIdentityResolver(hadith, quran, GATING_IDENTITY_RELATIONS) },
    reported: { identityOf: citationIdentityResolver(hadith, quran, REPORTED_IDENTITY_RELATIONS) },
    groups: hadith.groups,
  };
}
