import {
  identityResolver,
  type HadithIdentityRelation,
  type HadithIdentitySet,
} from "./hadith-identity";
import { quranIdentityResolver, type QuranIdentitySet } from "./quran-identity";

/**
 * The identity resolver the engine receives, composed from the domain's two
 * curated maps: hadith groups read under the caller's requested relations, then
 * the Qur'an pairs. The engine compares opaque keys and learns no vocabulary; this
 * composition lives in the domain pack because the maps and their label grammars
 * do.
 *
 * The two key spaces are the maps' canonical citation labels — a hadith key begins
 * with its collection marker, a Qur'an key with the verse marker — so a hadith key
 * can never equal a Qur'an key and a cross-map match cannot occur. A label in
 * neither map resolves to `null`, the fail-closed state.
 */
export function citationIdentityResolver(
  hadith: HadithIdentitySet,
  quran: QuranIdentitySet,
  relations: readonly HadithIdentityRelation[],
): (label: string) => string | null {
  const hadithOf = identityResolver(hadith, relations);
  const quranOf = quranIdentityResolver(quran);
  return (label) => hadithOf(label) ?? quranOf(label);
}
