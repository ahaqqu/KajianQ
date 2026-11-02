import { Effect } from "effect";
import {
  toStageError,
  type AssembledContext,
  type Assembler,
  type Chunk,
  type RoutedQuery,
  type Turn,
} from "@app/rag-core";
import { CALLER_PRIORITY_ORIGIN } from "./chat-caller-priority";
import {
  citationBaseAddress,
  isnadEvidenceOf,
  renderChainCitation,
  renderNarratorReliability,
} from "./chat-isnad";
import type { KajianQFilters } from "./filters";

/**
 * KajianQAssembler — Smart Router stage 5: order the retrieved chunks into the
 * Generator's turn list. Presentation order is {@link PRESENTATION_ORDER}, never the
 * authority order the system prompt states; within a slot, the caller-priority
 * guarantee's chunks lead in the order retrieval gave them, then the reranked score
 * decides when a rerank applied, else the fused score. The result is
 * deterministic — the runner records the `assembly` boundary event from it.
 *
 * Two product rules live here:
 *
 * - an Arabic original accompanies every quoted passage, and a machine translation is
 *   labelled as such (ADR-0006), so the model never reproduces Arabic from memory;
 * - the caller's earlier questions are rendered ahead of the evidence as a reference
 *   block, so a follow-up resolves against what was already asked — an earlier
 *   answer never is, because its citation labels are not this run's evidence
 *   (ADR-0068).
 */

/**
 * The **presentation order** (spec §3.3 item 5): Principles → Quran → Tafsir → Hadith →
 * Kitab — *how the Generator's turn is laid out*, deliberately NOT the usul **authority
 * order** the system prompt enforces. The Principle lens comes first because it is the
 * reading frame for everything after it. `tafsir` sits after `quran` (commentary with the
 * text it explains), and an unlisted source type sorts LAST, below every named source.
 */
export const PRESENTATION_ORDER: readonly string[] = [
  "principle",
  "quran",
  "tafsir",
  "hadith",
  "kitab",
];

function presentationRank(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const sourceType = meta["sourceType"];
  const rank = typeof sourceType === "string" ? PRESENTATION_ORDER.indexOf(sourceType) : -1;
  return rank === -1 ? PRESENTATION_ORDER.length : rank;
}

/** The machine-translation label (ADR-0006). Domain vocabulary lives here. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/** The product's narrator line label, in the evidence block's own language. */
export const NARRATOR_LINE_LABEL = "Narator";

/**
 * One evidence block, exactly as the Generator's prompt renders it — exported so the
 * Reviewer is shown the SAME evidence and cannot disagree with the prompt.
 *
 * **A passage with stored transmission rows renders those rows, never the flattened
 * grade.** The corpus label's trailing grade parenthetical is the v1 flattening, and
 * carrying it beside per-chain evidence would hand the model a single grade for a
 * passage whose chains disagree — the upgrade this evidence exists to prevent. So the
 * label is reduced to its address and each chain's own `(Grade — grader; sanad: …)`
 * attribution follows it, in stored order. The address itself is untouched, so the
 * citation gate grounds the answer's citations exactly as before.
 *
 * A narrator with a stored verdict also gets one line carrying the critic, the
 * verdict term and the source — the rows a narrator-reliability question is
 * answered from.
 */
export function renderEvidenceChunk(chunk: Chunk): string {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = typeof meta["citation"] === "string" ? meta["citation"] : "";
  const evidence = isnadEvidenceOf(chunk);
  const label =
    citation === ""
      ? ""
      : evidence === null
        ? ` [${citation}${flatGradeSuffix(citation, meta)}]`
        : ` [${[citationBaseAddress(citation), renderChainCitation(evidence)].join(" ").trim()}]`;
  const narratorLine = evidence === null ? "" : renderNarratorReliability(evidence);
  const chainLine =
    evidence !== null && narratorLine !== "" ? `\n${NARRATOR_LINE_LABEL}: ${narratorLine}` : "";
  // Arabic original first, then the display translation — the label is emitted only when
  // both layers are in hand, never claiming a translation of the original itself.
  const original = typeof meta["textAr"] === "string" ? meta["textAr"] : null;
  const translation = typeof meta["textId"] === "string" ? meta["textId"] : null;
  if (original !== null && original !== "" && translation !== null && translation !== "") {
    return `${original}\n(${MACHINE_TRANSLATION_LABEL})\n${translation}${label}${chainLine}`;
  }
  return `${chunk.text}${label}${chainLine}`;
}

/**
 * The flattened grade the corpus label appends when it lacks it: `HR. Malik no. 187
 * (Sahih)`. Only a passage with no chain evidence reaches this — the per-chain path
 * renders the rows themselves.
 */
function flatGradeSuffix(citation: string, meta: Record<string, unknown>): string {
  const gradeName = typeof meta["grade"] === "string" ? meta["grade"] : "";
  return gradeName !== "" && !citation.toLowerCase().includes(gradeName.toLowerCase())
    ? ` (${gradeName})`
    : "";
}

/**
 * The reference block's header. The generator prints the block ahead of the
 * evidence and states the non-evidence rule itself (`chat-prompts.ts`).
 */
const REFERENCE_HEADER = "Pertanyaan sebelumnya / Previous questions:";

/**
 * The prior-conversation reference: the caller's own earlier questions, one per
 * line, and nothing else. An earlier answer is deliberately absent — its citation
 * labels are text this run's retrieval may not hold, and a prompt that printed
 * them beside the evidence would invite a draft the citation gate must refuse
 * (ADR-0068). The generator places this block ahead of the evidence and tells
 * the model it is not evidence (`chat-prompts.ts`).
 */
function renderReference(turns: readonly { role: string; content: string }[]): string {
  if (turns.length === 0) return "";
  return [REFERENCE_HEADER, ...turns.map((turn) => `- ${turn.content}`)].join("\n");
}

/**
 * The ordering authority inside a presentation slot: a reranked chunk's
 * decision-model score when a rerank applied, else the fused score. A chunk
 * with neither (a deterministic expansion) sorts last in its slot, as before.
 * The fused score is never overwritten — the trace carries both — so this is
 * the one place the rerank order reaches the generator's context.
 */
function orderScore(chunk: Chunk): number {
  return chunk.rerankScore ?? chunk.score ?? 0;
}

/**
 * Whether the caller-priority guarantee leads this chunk's slot (ADR-0062). The
 * guarantee's rows are the caller's own dense ranking; they carry no
 * decision-model score because the rerank never reorders them, and their fused
 * score is a different scale from a rerank probability — so they are placed by
 * their tier, not by `orderScore`.
 */
function leadsItsSlot(chunk: Chunk): boolean {
  return chunk.origin === CALLER_PRIORITY_ORIGIN;
}

/**
 * Presentation slot first, then the guarantee's tier, then the score. The
 * guarantee's rows compare equal and `Array#sort` is stable, so they keep the
 * caller's dense-rank order retrieval gave them; no fused score or rerank
 * probability can outvote them. A guaranteed row stays in its own slot: the
 * presentation order is the spec's, not the guarantee's to override.
 */
function compareSlots(a: Chunk, b: Chunk): number {
  const byPresentation = presentationRank(a) - presentationRank(b);
  if (byPresentation !== 0) return byPresentation;
  const byGuarantee = Number(leadsItsSlot(b)) - Number(leadsItsSlot(a));
  if (byGuarantee !== 0) return byGuarantee;
  if (leadsItsSlot(a)) return 0;
  return orderScore(b) - orderScore(a);
}

export function createKajianQAssembler(): Assembler<KajianQFilters> {
  return {
    assemble: (routed: RoutedQuery<KajianQFilters>, chunks: readonly Chunk[]) =>
      toStageError(
        "assembler",
        Effect.sync(() => {
          const ordered = [...chunks].sort(compareSlots);
          const context = ordered.map(renderEvidenceChunk).join("\n\n");
          const reference = renderReference(referenceTurnsOf(routed));
          const turns: Turn[] = [];
          if (reference !== "") turns.push({ role: "user", content: reference });
          turns.push({ role: "user", content: context });
          // The context carries the *routed* query itself — the run's query context plus
          // the router's reading — never a rebuilt lookalike (ADR-0018).
          const ctx: AssembledContext<KajianQFilters> = {
            query: routed,
            chunks: ordered,
            turns,
          };
          return ctx;
        }),
      ),
  };
}

/** Prior turns ride the routed query, stamped there by the engine. Only the caller's
 * own questions are reference material: an answer is never rendered into the prompt
 * (ADR-0068). Malformed entries are dropped rather than crashing the answer path — a
 * bad history row must not take down a question. */
function referenceTurnsOf(routed: RoutedQuery<KajianQFilters>): Turn[] {
  const raw = routed.history;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((turn) => {
    if (turn === null || typeof turn !== "object") return [];
    const { role, content } = turn as { role?: unknown; content?: unknown };
    if (role !== "user" || typeof content !== "string" || content === "") return [];
    return [{ role, content }];
  });
}
