/**
 * The text a uuid-typed column stores for a spelling the request schemas admit.
 *
 * PostgreSQL's `uuid` cast is case-insensitive and the column returns the
 * canonical lowercase form, while `v.uuid()` admits the canonical hyphenated
 * shape in either case. The stand-in's uuid-keyed chat maps therefore key and
 * compare by this form, so a re-cased spelling reaches the row instead of
 * missing it.
 *
 * Only case needs canonicalising here: the cast's wider grammar (braces, a
 * hyphen-less 32-hex form, an extra hyphen after four digits) is refused by the
 * request schemas before the store, so such a spelling never names a row the
 * application can ask for. Maps whose keys are not a uuid column do not use
 * this: `traces`/`traceOwners` key on `answer_traces.message_id`, a TEXT column
 * the adapter compares exactly, and the auth, eval and feedback maps key on ids
 * the stand-in mints itself (`user<n>`, `s<n>`, `eval<n>`, `fb<n>`), which no
 * contract hands back re-cased.
 */
export function canonicalUuid(id: string): string {
  return id.toLowerCase();
}
