/**
 * citation-grammar.mjs — the domain's citation grammar as every eval CLI binds it.
 *
 * One copy, so `eval:run`, `eval:smoke` and `eval:probes` cannot normalize or
 * compare citations differently. The engine package stays domain-agnostic: these
 * are the DOMAIN's own functions — the same ones the deterministic citation gate
 * and the citations-frame derivation use — injected by the composition root.
 *
 * `addressesNamedBy` is the naming declaration the scorer compares a required
 * citation against the answer's evidence with: a question requires
 * `QS. 2:255`, the answer cites the grounded range `QS. 2:255-256`, and the two
 * are the same evidence once the range's addresses are read from the grammar
 * that declares them. The engine learns no domain vocabulary — it asks the
 * injected grammar what a label names.
 */
import {
  addressesNamedBy,
  citationCandidatesIn,
  normalizeCitationLabel,
} from "@app/kajianq-domain";

export const CITATION_GRAMMAR = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};
