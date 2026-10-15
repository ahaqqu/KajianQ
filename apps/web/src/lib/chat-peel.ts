import { messages } from "./i18n-messages";

/**
 * The rule-peel half of the answer renderer: the deterministic rule paragraphs the
 * postprocess appends — the dhaif warning, the machine-translation label and the ulama
 * disclaimer — are peeled into their own display blocks. `chat-render.ts` keeps the
 * markdown/inline half and re-exports this surface; the copy pair is pinned by
 * `tests/parity/chat-rule-copy.test.mjs`.
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block vocabulary the deterministic postprocess writes. Only a marker's OPENING
 * is matched, never the copy after it — `opensWith` states how wide that is.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = [
  "Jawaban ini bukan fatwa",
  "This answer is not a fatwa",
] as const;

/** The dhaif lines the peel treats as the product's own copy — both locales' i18n copy,
 * because an answer keeps its generated language while a UI language switch must still
 * render its line once. Marker-prefixed prose is not a line here and stays prose. */
const CANONICAL_WARNINGS: readonly string[] = [
  messages.en.dhaifWarningCard,
  messages.id.dhaifWarningCard,
];

/** A rule paragraph is one short line; anything longer is answer prose. */
const RULE_LINE_MAX = 200;

export type SplitAnswer = {
  body: string;
  /** The product's canonical dhaif line — the card's only grade-warning copy. */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/** The MT label's head, before its em-dash detail: the peel matches this head, bracket
 * optional, so a wording tweak inside the label cannot stop the walk. */
const MACHINE_TRANSLATION_HEAD = MACHINE_TRANSLATION_LABEL.split(" — ")[0]!;

/** True when `paragraph` opens with `marker`: `bracketed` requires the leading bracket,
 * comparison is case-insensitive, and the character after the marker is unconstrained. */
function opensWith(paragraph: string, marker: string, bracketed: boolean): boolean {
  if (bracketed && !paragraph.startsWith("[")) return false;
  const name = marker.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const opening = paragraph.startsWith("[") ? paragraph.slice(1).trimStart() : paragraph;
  return opening.toLowerCase().startsWith(name);
}

/** Where a rule paragraph peels: a `SplitAnswer` field, or `null` for `body`. */
type RuleField = "warning" | "disclaimer" | null;

type RuleKind = {
  field: RuleField;
  matches: (paragraph: string) => boolean;
};

/** The rule kinds, in match order: the walk follows the kind this table returns, so a rule
 * paragraph never terminates it — only prose does. */
const RULE_KINDS: readonly RuleKind[] = [
  { field: "warning", matches: (p) => WARNING_MARKERS.some((m) => opensWith(p, m, true)) },
  { field: "disclaimer", matches: (p) => DISCLAIMER_MARKERS.some((m) => opensWith(p, m, false)) },
  // Peels into no field: machine-translation provenance stays in `body`, in order.
  { field: null, matches: (p) => opensWith(p, MACHINE_TRANSLATION_HEAD, false) },
];

/** The canonical dhaif line this paragraph repeats, or `null` when it is not a repeat. The
 * test is a copy remainder, not a line split: drop every occurrence of a canonical line and
 * require whitespace only, so copy mixed with the model's own words stays prose, whole. */
function repeatOfCanonicalWarning(paragraph: string): string | null {
  return (
    CANONICAL_WARNINGS.find(
      (copy) => paragraph.includes(copy) && paragraph.replaceAll(copy, "").trim() === "",
    ) ?? null
  );
}

/** Classify one paragraph as a rule line (`kind` + trimmed text) or `null` for prose. Short
 * lines only — except the canonical copy, whose equality counts and whose byte-identical
 * repeats collapse to the one copy the card draws. */
function classifyRule(paragraph: string): { kind: RuleKind; text: string } | null {
  const repeat = repeatOfCanonicalWarning(paragraph);
  const text = repeat ?? paragraph.trim();
  if (text.length > RULE_LINE_MAX && !CANONICAL_WARNINGS.includes(text)) return null;
  const kind = RULE_KINDS.find((candidate) => candidate.matches(text));
  return kind === undefined ? null : { kind, text };
}

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning and the disclaimer
 * render as their own blocks, never as ordinary prose.
 * The peel walks the whole consecutive trailing run, because the postprocess appends
 * warning → MT label → disclaimer and a shorter peel would leave the warning in `body`. Each
 * kind dispatches once:
 * - **warning**: peels only when it equals the product's canonical line (`CANONICAL_WARNINGS`),
 *   so marker-prefixed prose stays prose; a repeat is dropped as the card renders it once.
 * - **disclaimer**: peels into its footer whatever `bukan fatwa` phrasing opens it (the
 *   server's loose predicate); an identical repeat is dropped, a different one stays.
 * - **MT label**: peels into no field and stays in `body`, in order, with the text it describes.
 * - anything else stops the walk, so prose is never eaten; only a repeat of copy the card still
 *   renders is dropped.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  const kept: string[] = []; // rule paragraphs that stay in the body, right-to-left
  let warning: string | null = null;
  let disclaimer: string | null = null;
  let cut = paragraphs.length; // first index of the trailing rule run
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const rule = classifyRule(paragraphs[i]!);
    if (rule === null) break;
    cut = i;
    if (rule.kind.field === "warning") {
      if (warning === null && CANONICAL_WARNINGS.includes(rule.text)) warning = rule.text;
      else if (rule.text !== warning) kept.push(rule.text); // marker prose, not a trust line
    } else if (rule.kind.field === "disclaimer") {
      if (disclaimer === null) disclaimer = rule.text;
      else if (rule.text !== disclaimer) kept.push(rule.text);
    } else {
      kept.push(rule.text);
    }
  }
  return {
    body: [...paragraphs.slice(0, cut), ...kept.reverse()].join("\n\n"),
    warning,
    disclaimer,
  };
}
