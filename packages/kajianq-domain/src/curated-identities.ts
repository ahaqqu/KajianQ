import { readFileSync } from "node:fs";
import { citationIdentityResolver } from "./citation-identity";
import {
  GATING_IDENTITY_RELATIONS,
  parseHadithIdentitySet,
  type HadithIdentityGroup,
} from "./hadith-identity";
import { parseQuranIdentitySet } from "./quran-identity";

/**
 * The resolvers the engine's eval scorer reads, built from the domain pack's own
 * owner-signed fixtures. One loader serves every composition root, so the staging
 * harness and the tests that verify the instruments against the curated data cannot
 * drift about which maps are loaded or which relation each mode reads.
 *
 * `gating` is citation validity's resolver: the signed hadith groups of both
 * relations plus the curated verse pairs, because a report's parallel chain and a
 * different report of its ruling are both the identity the question asks for.
 * `reported` is the same resolver: the reported identity-satisfied block reads one
 * signed map and differs from the gate only in the leg it widens (the address
 * comparison), so the relation list has one source. The engine compares the opaque
 * keys; the relation vocabulary and the citation grammar stay here, in the domain
 * pack.
 *
 * The maps are read on call, not at import: a process that never scores pays no
 * file read, and a malformed fixture fails at the call that needed it.
 */
export type CuratedIdentityResolvers = {
  gating: { identityOf: (label: string) => string | null };
  /** The same resolver as `gating`; the separate key is the optional delivery the
   * harness reads to publish the counterfactual block. */
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
  const gating = { identityOf: citationIdentityResolver(hadith, quran, GATING_IDENTITY_RELATIONS) };
  return { gating, reported: gating, groups: hadith.groups };
}
