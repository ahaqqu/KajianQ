import { Effect } from "effect";
import {
  type Chunk,
  type Decider,
  type DecisionSpec,
  type NoulQuestion,
  type ProviderError,
  type RunContextService,
} from "@app/rag-core";
import type { Stage } from "@app/contracts";
import {
  citationLabelsOf,
  citationMatchText,
  citationSpansIn,
  normalizeCitationLabel,
} from "./chat-citation-validator";
import { CITATION_CRITERIA, CITATION_INSTRUCTIONS } from "./decision-bench-prompts";

/**
 * Re-exported so the reviewer stage holds its two citation screens behind one
 * import surface (the agentic import cap allows five imports per file, and the
 * deterministic gate must stay first in the order). `chat-citation-validator`
 * remains the one owner of the comparison — this is an alias, not a second
 * implementation, exactly like the prompt module's own re-export surface.
 */
export { validateCitations } from "./chat-citation-validator";

/**
 * The reviewer pre-gate (ADR-0042 adoption, ticket #168): one batched
 * decision-model call screens every citation of a draft answer before the paid
 * LLM reviewer runs. This module is the **reference implementation of the
 * decision-model serving pattern** every later adoption reuses:
 *
 *  1. the serving role's `Decider` is injected (never constructed here — the
 *     vendor is config, ADR-0009/ADR-0022), and its absence means the stage
 *     behaves exactly as it did before adoption;
 *  2. every judgment item is one question in **one** request, keyed by
 *     position, with the state carrying what is being judged;
 *  3. the call's spend lands on the trace as an `llm_call` event and the
 *     verdict as a `decision` event, so the trace total stays the sum of
 *     recorded calls (traceability rule 2);
 *  4. **fail-open**: anything short of an explicit all-items-cleared answer —
 *     a low or out-of-range score, a missing/unreadable answer, a vendor
 *     failure, or no items at all — returns `escalate`, i.e. the existing path.
 *
 * Adoption #2 extracts the generic half of this runner (ADR-0042 Adoption #2).
 *
 * The trust property it protects: *an answer is never cleared by the decision
 * model alone.* The pre-gate can only ever **skip** the LLM reviewer when the
 * vendor affirmatively cleared every citation; every other outcome, including
 * every way the call can go wrong, keeps today's full review. The silent
 * failure this design exists to prevent is the reverse: a malformed or failed
 * decision response read as a pass, which would ship unreviewed answers with a
 * trace that looks clean.
 *
 * The question wording is the domain pack's (the same language-neutral
 * citation question the multilingual gate benchmarked — ADR-0042), so the
 * engine's `DecisionSpec` stays opaque protocol data.
 */

/** The `decision` trace event's purpose label for this screen. */
export const CITATION_SUPPORT_PURPOSE = "citation_support";

/**
 * Per-citation Noul ≥ this value = supported (ADR-0042; the threshold the gate
 * bench scored 6/6 citation cases with). Every citation clearing it is what
 * makes the draft reviewed-clean.
 */
export const CITATION_SUPPORT_THRESHOLD = 0.5;

/** One citation the pre-gate will judge: what was claimed, from which passage. */
export type CitationPregateItem = {
  /** The normalized citation label (the item's identity in the request). */
  label: string;
  /** The draft's claim span carrying that citation. */
  claim: string;
  /** The retrieved passage(s) the citation points at, verbatim. */
  passage: string;
};

/** The pre-gate's verdict: the stage either skips its paid path or runs it. */
export type CitationPregateOutcome = { kind: "skip" } | { kind: "escalate" };

/** The question key for citation position `index` (`c0`, `c1`, …). */
export function citationQuestionKey(index: number): string {
  return `c${index}`;
}

/**
 * A usable Noul answer: finite **and** within the seam's documented 0..1 range —
 * `5` would otherwise read as support and skip the paid reviewer.
 */
export function isNoulScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Build the batched decision request for a draft, or `null` when the draft
 * carries no citation-shaped span at all (nothing to clear → no call, no
 * spend; the caller escalates).
 *
 * One question per citation position, in the order the citations appear in the
 * draft, and the state carries each position's claim span and cited passage —
 * the vendor answers keyed by position, so a citation's score can never be
 * attributed to another citation.
 */
export function planCitationPregate(input: {
  draft: string;
  chunks: readonly Chunk[];
}): { items: readonly CitationPregateItem[]; spec: DecisionSpec } | null {
  const citations = citationSpansIn(input.draft);
  if (citations.length === 0) return null;

  const claims = claimSpansIn(input.draft);
  const passages = passagesByCitation(input.chunks);
  const items: CitationPregateItem[] = citations.map((citation) => ({
    label: citation.label,
    claim: claimForCitation(claims, citation.label) ?? input.draft.trim(),
    passage: (passages.get(citation.label) ?? []).join("\n\n"),
  }));

  const questions: Record<string, NoulQuestion> = {};
  items.forEach((_, index) => {
    questions[citationQuestionKey(index)] = {
      type: "noul",
      instructions: CITATION_INSTRUCTIONS,
      criteria: { ...CITATION_CRITERIA },
    };
  });

  return {
    items,
    spec: {
      // The claim spans are the user's answer text: a declared personal-data
      // call (ADR-0043), so the seam can refuse a vendor that forbids it.
      personalData: true,
      state: {
        citations: items.map(({ claim, passage }) => ({ claim, passage })),
      },
      questions,
    },
  };
}

/**
 * Run the pre-gate for one draft and record its trace events. Never fails: a
 * vendor failure is classified, traced, and escalated (fail-open), so the
 * caller's effect channel stays clean.
 */
export function runCitationPregate(input: {
  decider: Decider;
  draft: string;
  chunks: readonly Chunk[];
  /** The stage recording the events (the decision event's `stage`). */
  stage: Stage;
  /** The run's trace sink + clock (the single collection point, ADR-0021). */
  run: Pick<RunContextService, "now" | "record">;
  /** Overridable for tests; the product policy default is the ADR-0042 threshold. */
  threshold?: number;
}): Effect.Effect<CitationPregateOutcome> {
  const threshold = input.threshold ?? CITATION_SUPPORT_THRESHOLD;
  const purpose = CITATION_SUPPORT_PURPOSE;
  const plan = planCitationPregate({ draft: input.draft, chunks: input.chunks });

  // No citation, no judgment: the pre-gate cannot attest anything about a
  // draft it has nothing to check, so it must not clear it. Escalate — the
  // LLM reviewer sees exactly what it sees today.
  if (plan === null) {
    input.run.record({
      stage: input.stage,
      kind: "decision",
      detail: { purpose, outcome: "escalate", reason: "no_items", threshold, items: [] },
      at: input.run.now(),
    });
    return Effect.succeed({ kind: "escalate" });
  }

  return Effect.match(input.decider.decide(plan.spec), {
    onSuccess: (result) => {
      // Read every answer through the seam's typed union: a missing answer, a
      // wrong answer type, or a non-finite score is an unusable item, never an
      // implicit pass (the silent failure this module exists to prevent).
      const items = plan.items.map((item, index) => {
        const answer = result.answers[citationQuestionKey(index)];
        const score = answer?.type === "noul" && isNoulScore(answer.noul) ? answer.noul : undefined;
        return {
          index,
          key: item.label,
          ...(score !== undefined ? { score } : {}),
        };
      });
      input.run.record({
        stage: input.stage,
        kind: "llm_call",
        detail: { purpose },
        cost: result.cost,
        at: input.run.now(),
      });
      const unusable = items.some((item) => item.score === undefined);
      const below = items.some((item) => item.score !== undefined && item.score < threshold);
      // A vendor-side doubt (no usable answer) is reported as such; a scored
      // item below the threshold is the content-side doubt. Both escalate.
      const reason = unusable
        ? ("malformed_answer" as const)
        : below
          ? ("below_threshold" as const)
          : undefined;
      input.run.record({
        stage: input.stage,
        kind: "decision",
        detail: {
          purpose,
          outcome: reason === undefined ? "skip" : "escalate",
          ...(reason !== undefined ? { reason } : {}),
          threshold,
          items,
        },
        at: input.run.now(),
      });
      return reason === undefined ? { kind: "skip" as const } : { kind: "escalate" as const };
    },
    onFailure: (error: ProviderError) => {
      // An attempt that reached the vendor spent real tokens even though it
      // failed; each one stays on the cost trail (traceability rule 2). The
      // items are listed unscored: the request was built, no judgment came
      // back.
      for (const attempt of error.attemptCosts ?? []) {
        input.run.record({
          stage: input.stage,
          kind: "llm_call",
          detail: { purpose },
          cost: attempt,
          at: input.run.now(),
        });
      }
      input.run.record({
        stage: input.stage,
        kind: "decision",
        detail: {
          purpose,
          outcome: "escalate",
          reason: "vendor_failure",
          threshold,
          items: plan.items.map((item, index) => ({ index, key: item.label })),
        },
        at: input.run.now(),
      });
      return { kind: "escalate" as const };
    },
  });
}

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

/** The claim span a citation sits in (matched the way the gate grounds it). */
export function claimForCitation(
  spans: readonly string[],
  normalizedLabel: string,
): string | undefined {
  return spans.find((span) => citationMatchText(span).includes(normalizedLabel));
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
