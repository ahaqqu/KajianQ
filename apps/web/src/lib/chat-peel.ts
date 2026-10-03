import { messages } from "./i18n-messages";

/**
 * The rule-peel half of the answer renderer (#11, split out in #353): the
 * deterministic rule paragraphs the postprocess appends — the dhaif warning,
 * the ADR-0006 MT label and the ulama disclaimer — are located in the answer
 * text and peeled into their own display blocks. `chat-render.ts` keeps the
 * markdown/inline half and re-exports this module's public surface for its
 * direct readers, so the split is a module-graph change, not an API change.
 *
 * The client/server copy pair (the warning line, the MT label, the marker
 * vocabulary) is pinned by `tests/parity/chat-rule-copy.test.mjs`, which
 * imports both sides.
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block vocabulary the deterministic postprocess writes (the warning's
 * bracket marker, the disclaimer's "bukan fatwa" invariant phrase — the same
 * phrases the postprocess matches on). Only a marker's OPENING is matched,
 * never the copy after it; `opensWith` states exactly how wide that is.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = [
  "Jawaban ini bukan fatwa",
  "This answer is not a fatwa",
] as const;

/**
 * The dhaif lines the peel treats as the product's own copy — both locales'
 * i18n copy, because an answer keeps the language it was generated in and a UI
 * language switch must still render its line once. Marker-prefixed prose
 * equals no line here and stays prose (A2); the parity spec pins both.
 */
const CANONICAL_WARNINGS: readonly string[] = [
  messages.en.dhaifWarningCard,
  messages.id.dhaifWarningCard,
];

/** A rule paragraph is one short line; anything longer is answer prose. */
const RULE_LINE_MAX = 200;

export type SplitAnswer = {
  /** The answer text without the rule paragraphs the peel consumed. */
  body: string;
  /** The product's canonical dhaif line — the card's only grade-warning copy (A2). */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/**
 * The MT label's head, before its em-dash detail — what a wording tweak inside
 * the label leaves alone. The peel matches this head, bracket optional, so the
 * tweak cannot stop the walk (#292); the parity spec pins the full label.
 */
const MACHINE_TRANSLATION_HEAD = MACHINE_TRANSLATION_LABEL.split(" — ")[0]!;

/**
 * True when `paragraph` opens with `marker`: the leading bracket is required
 * when `bracketed`, comparison is case-insensitive, and the character where the
 * marker ends is unconstrained — `[peringatan]`, `[Peringatan:`, `[Warning!]`
 * all classify. Nothing after the marker is inspected.
 */
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
  /** True when the trimmed paragraph is this kind of rule line. */
  matches: (paragraph: string) => boolean;
};

/**
 * The rule kinds, in match order. The walk follows the kind this table returns,
 * so a rule paragraph never terminates it — only prose does (#292).
 */
const RULE_KINDS: readonly RuleKind[] = [
  { field: "warning", matches: (p) => WARNING_MARKERS.some((m) => opensWith(p, m, true)) },
  { field: "disclaimer", matches: (p) => DISCLAIMER_MARKERS.some((m) => opensWith(p, m, false)) },
  // Peels into no field: ADR-0006 provenance that stays in `body`, in order.
  { field: null, matches: (p) => opensWith(p, MACHINE_TRANSLATION_HEAD, false) },
];

/**
 * The canonical dhaif line this paragraph repeats, or `null` when it is not a
 * repeat. The model writes the repeat two ways: one copy per line (#348) and
 * the copies space-separated on ONE line (#361 — three ID copies are 281 chars,
 * so the single line fails both the equality test and the 200-char
 * `RULE_LINE_MAX`, classifies as `null` and stops the walk). Both are the same
 * fact — the paragraph is nothing but the product's own copy — so the test is a
 * copy remainder, not a line split: drop every occurrence of a canonical line
 * and require whitespace only. A copy mixed with the model's own words, or a
 * paragraph that merely opens with a marker, leaves a remainder and stays
 * prose, whole (A2).
 */
function repeatOfCanonicalWarning(paragraph: string): string | null {
  return (
    CANONICAL_WARNINGS.find(
      (copy) => paragraph.includes(copy) && paragraph.replaceAll(copy, "").trim() === "",
    ) ?? null
  );
}

/**
 * Classify one paragraph as a rule line (`kind` + trimmed text) or `null` for
 * prose. Short lines only — except the canonical copy, whose equality counts;
 * a paragraph of byte-identical copies collapses to the one copy the card
 * draws, so its repeats are dropped with it and never reach `body` (#348 for
 * line-separated copies, #361 when they are space-separated on one line).
 */
function classifyRule(paragraph: string): { kind: RuleKind; text: string } | null {
  const repeat = repeatOfCanonicalWarning(paragraph);
  const text = repeat ?? paragraph.trim();
  if (text.length > RULE_LINE_MAX && !CANONICAL_WARNINGS.includes(text)) return null;
  const kind = RULE_KINDS.find((candidate) => candidate.matches(text));
  return kind === undefined ? null : { kind, text };
}

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning
 * and the disclaimer render as their own visually distinct blocks (spec
 * §2.2), never as ordinary prose.
 *
 * The peel walks the *whole consecutive trailing run of rule paragraphs*, not
 * the last two (#292): the postprocess appends warning → MT label →
 * disclaimer, so the MT label is last on the common path and a two-pop peel
 * left the warning in `body` — drawn as prose *and* again by the card. Each
 * kind dispatches once:
 *
 * - the **warning** peels only when it equals the product's canonical line
 *   (`CANONICAL_WARNINGS`), so marker-prefixed model prose stays prose and can
 *   never become a trust card (A2); a repeat of an already-peeled copy — one
 *   copy per line (#348) or copies space-separated on one line (#361) — is
 *   dropped, because the card renders that copy once;
 * - the **disclaimer** peels into its footer whatever `bukan fatwa` phrasing
 *   opens it (the server's own loose predicate, #284); an identical repeat is
 *   dropped, a different one stays in `body`;
 * - the **MT label** peels into no field and stays in `body`, in order, so the
 *   provenance claim renders with the text it describes;
 * - anything else stops the walk, so prose is never eaten — and no paragraph is
 *   dropped except a repeat of copy the card still renders.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  const kept: string[] = []; // rule paragraphs that stay in the body, right-to-left
  let warning: string | null = null;
  let disclaimer: string | null = null;
  let cut = paragraphs.length; // first index of the trailing rule run
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const rule = classifyRule(paragraphs[i]!);
    if (rule === null) break; // answer prose ends the trailing run
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
