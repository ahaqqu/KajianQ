/**
 * Quote-normalisation equivalences for KajianQ's own language and corpus.
 *
 * The eval harness folds case, punctuation and combining marks generically, for every
 * script it meets. What Unicode cannot know is that Indonesian writes the space inside a
 * divine epithet either way: "Maha Perkasa" and "Mahaperkasa" are the same two words, so a
 * quotation that differs from its source only there must not be scored as a paraphrase.
 * That rule is KajianQ's, not the engine's, so it lives here and the eval composition root
 * hands it to the harness.
 */
export const QUOTE_EQUIVALENCES: readonly {
  readonly pattern: RegExp;
  readonly replacement: string;
}[] = [{ pattern: /\bmaha\s+/gu, replacement: "maha" }];
