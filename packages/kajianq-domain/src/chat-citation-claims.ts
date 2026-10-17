/**
 * The pre-gate's two read-outs of a draft answer, both decided by the citation
 * grammar and the gate's own comparison form — which is why they sit in the
 * citation family rather than beside the decision-model call: the **claim span** a
 * citation sits in, and the **passages** every retrieved label carries.
 *
 * The split from `chat-reviewer-pregate` is for the file-size cap, not a new seam:
 * the module is internal to the domain pack, the pre-gate is its only caller, and
 * both functions read the citation scan `chat-citation-validator` owns.
 */
import type { Chunk } from "@app/rag-core";
import {
  citationLabelsOf,
  citationSpansIn,
  normalizeCitationLabel,
} from "./chat-citation-validator";

/**
 * The draft's claim spans: sentences and lines, with every citation span
 * masked out before the split so a citation's own punctuation (`QS. 2:255`)
 * can never cut its claim in half. The spans partition the draft (their union
 * is the text), so a citation the deterministic validator grounded is always
 * inside exactly one of them.
 */
function claimSpansIn(text: string): string[] {
  const masked = text.split("");
  for (const citation of citationSpansIn(text)) {
    for (let i = citation.start; i < citation.end; i += 1) masked[i] = "x";
  }
  const boundaries = /[.!?…]+\s+|\n+/g;
  const spans: string[] = [];
  let start = 0;
  for (const match of masked.join("").matchAll(boundaries)) {
    const end = (match.index ?? 0) + match[0].length;
    spans.push(text.slice(start, end));
    start = end;
  }
  spans.push(text.slice(start));
  return spans.map((span) => span.trim()).filter((span) => span !== "");
}

/**
 * The claim span a citation sits in: the span whose **own** citation labels
 * include it. Compared label against label, so the lookup never rests on the
 * citation comparison form preserving containment — a property of a spelling rule
 * rather than of this read, and one a fold of the collection name has to earn at
 * every position it rewrites.
 */
export function claimForCitation(
  spans: readonly string[],
  normalizedLabel: string,
): string | undefined {
  return spans.find((span) =>
    citationSpansIn(span).some((citation) => citation.label === normalizedLabel),
  );
}

/**
 * Every citation of a draft with the claim span it sits in — the pre-gate's items
 * before their passages are joined. A citation whose claim no span matches (the
 * span partition is the draft's own sentences, so this is the degenerate case, not
 * the ordinary one) is claimed by the whole draft: the vendor judges it against the
 * widest honest reading of what the answer asserted rather than against nothing.
 */
export function citationClaimsIn(draft: string): readonly { label: string; claim: string }[] {
  const spans = claimSpansIn(draft);
  return citationSpansIn(draft).map((citation) => ({
    label: citation.label,
    claim: claimForCitation(spans, citation.label) ?? draft.trim(),
  }));
}

/** Citation label → the retrieved passages that carry it (in chunk order). */
export function passagesByCitation(chunks: readonly Chunk[]): Map<string, string[]> {
  const byLabel = new Map<string, string[]>();
  for (const chunk of chunks) {
    for (const raw of citationLabelsOf(chunk)) {
      const label = normalizeCitationLabel(raw);
      if (label === "") continue;
      const passages = byLabel.get(label) ?? [];
      if (!passages.includes(chunk.text)) passages.push(chunk.text);
      byLabel.set(label, passages);
    }
  }
  return byLabel;
}
