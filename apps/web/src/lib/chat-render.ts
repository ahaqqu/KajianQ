import type { ChatCitation } from "@app/contracts";

/**
 * Rendering rules for an assistant answer (#11). The citation payload comes
 * from the server's structured frame — this module never decides what IS a
 * citation (no grammar parsing): it only LOCATES the frame's labels in the
 * answer text so they render as chips. The dhaif warning and the ulama
 * disclaimer are split out of the text into their own blocks by matching the
 * product's canonical copy (kajianq-domain's chat-postprocess constants —
 * drift is guarded by chat-render.test.ts, which imports both sides).
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block markers the deterministic postprocess writes (stable
 * product vocabulary — the warning's bracket marker, the disclaimer's
 * "bukan fatwa" invariant phrase, the same phrases the postprocess itself
 * matches on). Block-splitting matches these PREFIXES, not the full copy,
 * so wording tweaks cannot silently stop the blocks from peeling.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = ["Jawaban ini bukan fatwa", "This answer is not a fatwa"] as const;

/** A rule paragraph is one short line; anything longer is answer prose. */
const RULE_LINE_MAX = 200;

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; label: string };

/**
 * Split the answer text into plain-text and citation-chip segments. A chip
 * replaces the whole bracketed span `[label]` when present, else the bare
 * label. A frame label that does not occur in the text produces nothing —
 * the text stays verbatim, and no chip is invented.
 */
export function renderAnswerSegments(
  text: string,
  citations: readonly ChatCitation[],
): AnswerSegment[] {
  const matches: { start: number; end: number; label: string }[] = [];
  for (const citation of citations) {
    for (const form of [`[${citation.label}]`, citation.label]) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(form, from);
        if (at === -1) break;
        matches.push({ start: at, end: at + form.length, label: citation.label });
        from = at + form.length;
      }
      if (matches.some((m) => m.label === citation.label)) break;
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // overlapping — first (leftmost) wins
    if (match.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.start) });
    }
    segments.push({ kind: "citation", label: match.label });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export type SplitAnswer = {
  /** The answer text without its trailing warning/disclaimer paragraphs. */
  body: string;
  /** The canonical dhaif warning, when the text carries it. */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning
 * and the disclaimer render as their own visually distinct blocks (spec
 * §2.2), never as ordinary prose. Matching is exact-equality on the product's
 * own copy — our strings, not the model's phrasing.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  let disclaimer: string | null = null;
  let warning: string | null = null;
  const takeIfMarked = (paragraph: string, markers: readonly string[]): string | null => {
    const trimmed = paragraph.trim();
    return trimmed.length <= RULE_LINE_MAX && markers.some((m) => trimmed.startsWith(m))
      ? trimmed
      : null;
  };
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!;
    disclaimer = takeIfMarked(last, DISCLAIMER_MARKERS);
    if (disclaimer !== null) paragraphs.pop();
  }
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!;
    warning = takeIfMarked(last, WARNING_MARKERS);
    if (warning !== null) paragraphs.pop();
  }
  return { body: paragraphs.join("\n\n"), warning, disclaimer };
}
