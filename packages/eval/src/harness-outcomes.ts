import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import { StoreError } from "@app/rag-core";
import type {
  ChunkRefLike,
  CitationFrameLike,
  CitationGrammar,
  QuoteEquivalence,
  TraceEventLike,
} from "./harness-types";
import { auditQuotes } from "./quote-fidelity";
import { citationEvidenceLabels, sourceTypeRecall } from "./scorers";

/** Per-question outcome helpers, split out of `harness.ts` to respect the agentic
 * size limits: the expansion provenance, the transport-skip outcome, the
 * quote-fidelity and answer-size outcomes, their run aggregates, and the
 * ledger-write-failure note both write paths share. */

/**
 * The per-question deterministic-path provenance: the number of scope-origin refs,
 * the source-type recall the fused refs alone would have scored, and — when the
 * citation-label lookup ran — its own contribution beside that figure.
 *
 * `sourceTypeRecall` never inspects a ref's `origin` label, so for a question that
 * names a reference a deterministic read satisfies the scored leg by
 * construction, and a fused-track regression on exactly those questions would
 * otherwise be invisible. A `fusedOnlySourceTypeRecall` below the reported
 * `sourceTypeRecall` states that a deterministic arm carried the question; the
 * metric itself is never redefined.
 *
 * **"The fused refs alone" means the refs fusion produced** — unlabelled rows,
 * plus the rows a rule labels *without changing their provenance*: the
 * caller-priority guarantee promotes fused rows and marks them, so they stay in
 * this leg. Chunks a deterministic path **added** leave it. That is what keeps
 * the gap meaningful: a label that means "do not reorder me" is not evidence an
 * arm carried the question. The caller-priority label is supplied by the
 * composition root like the others (`callerPriorityOrigin`), so the engine never
 * names a caller's vocabulary. `expansion.chunks` stays the **scope** path's
 * count; a neighbour-only question reports no block.
 *
 * The block is written whenever **any** deterministic path ran: the scope read
 * (`expansionOrigin`), or the citation-label lookup — a lookup event or a
 * lookup-origin ref (`lookupOrigin`). The label-only shape is the one that needs
 * it most: the lookup can be the only arm that satisfied the question, and a
 * report without this block says nothing about the fused track it outran. The
 * `lookup` field is present only when the lookup path ran, like `chunks` only
 * ever counting the scope path.
 */
export function expansionProvenance(input: {
  expectedSourceTypes: readonly string[];
  chunks: readonly ChunkRefLike[];
  events: readonly TraceEventLike[];
  sourceTypeOf: (chunkId: string) => string | undefined;
  /** Opaque caller label (domain vocabulary stays at the composition root). */
  expansionOrigin?: string;
  /** Opaque caller label for the citation-label lookup's chunks. */
  lookupOrigin?: string;
  /** Opaque caller label for the caller-priority guarantee's promoted fused rows. */
  callerPriorityOrigin?: string;
}): { expansion?: EvalResultOutcome["expansion"] } {
  const { expansionOrigin, lookupOrigin, callerPriorityOrigin } = input;
  if (expansionOrigin === undefined && lookupOrigin === undefined) return {};
  const expansionChunks =
    expansionOrigin === undefined
      ? []
      : input.chunks.filter((chunk) => chunk.origin === expansionOrigin);
  // A recognised-but-empty scope still counts as "the scoped path ran".
  const scopedPathRan =
    expansionChunks.length > 0 || input.events.some((e) => e.kind === "scope_expansion");
  const lookupEvent = input.events.filter((e) => e.kind === "citation_lookup").at(-1);
  const lookupChunks =
    lookupOrigin === undefined ? [] : input.chunks.filter((chunk) => chunk.origin === lookupOrigin);
  // A lookup that resolved nothing still leaves its event: "ran and found none"
  // is exactly the state the block must not hide.
  const lookupPathRan = lookupChunks.length > 0 || lookupEvent !== undefined;
  if (!scopedPathRan && !lookupPathRan) return {};

  // A fused ref is one no arm added: unlabelled, or labelled by the promotion
  // rule that moves a fused row without changing where it came from.
  const fused = input.chunks.filter(
    (chunk) =>
      chunk.origin === undefined ||
      (callerPriorityOrigin !== undefined && chunk.origin === callerPriorityOrigin),
  );
  const expansion: NonNullable<EvalResultOutcome["expansion"]> = {
    chunks: expansionChunks.length,
    fusedOnlySourceTypeRecall: sourceTypeRecall(
      input.expectedSourceTypes,
      fused,
      input.sourceTypeOf,
    ),
  };
  if (lookupPathRan) {
    const detail = lookupEvent?.detail;
    expansion.lookup = {
      returned: detail?.returned ?? lookupChunks.length,
      missing: detail?.missing?.length ?? 0,
      dropped: detail?.dropped?.length ?? 0,
      truncated: detail?.truncated === true,
      // The expected sources the fused refs alone did not cover: what the
      // lookup carried into the scored recall, named rather than counted.
      carriedSourceTypes: input.expectedSourceTypes.filter(
        (type) =>
          lookupChunks.some((chunk) => input.sourceTypeOf(chunk.id) === type) &&
          !fused.some((chunk) => input.sourceTypeOf(chunk.id) === type),
      ),
    };
  }
  return { expansion };
}

/** The text for anything a `catch` can hand us: `cause` is `unknown` by
 * contract, so a wrapped exception, a bare string, a plain object and
 * `undefined` all arrive here. */
function thrownText(value: unknown): string {
  if (value === undefined || value === null) return "no cause";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message !== "" ? value.message : value.name;
  if (typeof value === "object") {
    const { message } = value as { message?: unknown };
    if (typeof message === "string" && message !== "") return message;
    try {
      return JSON.stringify(value);
    } catch {
      // Circular or otherwise unserialisable: nothing to report.
      return "";
    }
  }
  return String(value);
}

/**
 * The note a failed ledger write leaves on a question's outcome, shared by the
 * scored and the skipped write path. It is **report-only**: a failed write leaves
 * no row, and an ambiguous one (the INSERT committed, the response was lost)
 * leaves a row carrying the bare cause — the report can name a cause the store
 * does not, never the other way round. `StoreError` has an EMPTY `message`, so the
 * cause is read from `kind` and the wrapped `cause`.
 */
export function ledgerFailureNote(err: unknown): string {
  const cause =
    err instanceof StoreError ? `${err.kind}: ${thrownText(err.cause)}` : thrownText(err);
  return `ledger_write_failed: ${cause === "" ? "no cause" : cause}`;
}

/**
 * The outcome for a question whose transport failed: never asked, never scored, so
 * every scored field is zero and `skipped` is true — the flag that keeps this mode
 * unmistakable from the two scored failures it resembles on `passed` /
 * `citationValidity` alone.
 *
 * The `notes` entry is the durable cause, persisted to the eval ledger with this
 * same outcome; a write that does not land has no row.
 */
export function skippedOutcome(question: GoldenQuestion, err: unknown): EvalResultOutcome {
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed: false,
    sourceTypeRecall: 0,
    citationAddressRecall: 0,
    citationValidity: 0,
    refused: false,
    skipped: true,
    notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
  };
}

/**
 * Quote fidelity for one answer, from the text the citations frame carries.
 *
 * Omitted — never scored 0 — when the answer quotes nothing, the frame carries no cited text, or
 * every quoted span is shorter than the extractor's minimum: none of those says anything about
 * whether the evidence checks out, and a 0 would read as a failed claim. Verifies existence, not
 * attribution: a span found in any cited chunk counts.
 *
 * A score below 1 carries the count of spans that appeared in no cited chunk on `notes`, so the
 * persisted ledger explains the fraction without storing the spans themselves.
 */
export function quoteFidelityOutcome(
  answerText: string,
  frame: CitationFrameLike | null | undefined,
  equivalences: readonly QuoteEquivalence[] = [],
): { quoteFidelity?: number; notes?: string[] } {
  const citedTexts = (frame?.citations ?? []).flatMap((citation) =>
    [citation.translation, citation.arabic].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    ),
  );
  const quotes = auditQuotes(answerText, citedTexts, equivalences);
  if (quotes.quoted === 0 || citedTexts.length === 0) return {};
  const quoteFidelity = quotes.verified / quotes.quoted;
  return {
    quoteFidelity,
    ...(quoteFidelity < 1
      ? { notes: [`quote_unverified: ${quotes.unverifiable.length} of ${quotes.quoted} spans`] }
      : {}),
  };
}

/**
 * The citation labels one answer carries, under the gate's own evidence precedence:
 * the citations frame first (an EMPTY frame is authoritative), then the trace's
 * review-event grounded list, then the injected grammar's spans in the answer text.
 *
 * Deduplicated under the grammar's normalization, so a repeated citation counts once
 * and one range label counts once even though it names several addresses. With
 * neither non-text evidence nor a grammar the text cannot be split into citations, so
 * this returns `undefined` — never `[]`: an empty answer carrying no citation is a
 * measured 0, while an unsplittable text with no evidence source is unmeasured.
 */
export function answerCitationLabels(input: {
  answerText: string;
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
  grammar?: CitationGrammar | undefined;
}): string[] | undefined {
  const evidence = citationEvidenceLabels({ frame: input.frame, events: input.events });
  const labels =
    evidence ??
    (input.grammar === undefined ? undefined : input.grammar.labelsInText(input.answerText));
  if (labels === undefined) return undefined;
  const normalize = input.grammar?.normalizeLabel;
  return [...new Set(labels.map((label) => (normalize === undefined ? label : normalize(label))))];
}

/**
 * One answer's descriptive statistics. Length is in Unicode code points, so an astral
 * character counts once, and it is always measurable. `citationCount` is **absent**
 * when no source could count the answer's citations (no frame, no trace grounded list,
 * no grammar): that row was never measured, and a 0 there would be a fabricated
 * measurement. An empty frame or a grammar that finds no span is a real 0.
 */
export function answerStats(input: {
  answerText: string;
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
  grammar?: CitationGrammar | undefined;
}): { answerChars: number; citationCount?: number } {
  const labels = answerCitationLabels(input);
  return {
    answerChars: Array.from(input.answerText).length,
    ...(labels === undefined ? {} : { citationCount: labels.length }),
  };
}

/** The mean over the measured rows, or null when none was measured. */
function meanOf(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * The per-run mean and maximum answer length and citations per answer, over the
 * scored outcomes that carry the measurements. A row persisted before the metric
 * existed is excluded from every figure rather than counted as zero, because "never
 * measured" and "measured zero" are different facts. All four are null when no answer
 * was measured.
 *
 * One derivation, shared by the persisted report and the CLI summary, so the printed
 * figures and the stored ones cannot drift apart.
 */
export function answerMetricsSummary(scored: readonly EvalResultOutcome[]): {
  meanAnswerChars: number | null;
  maxAnswerChars: number | null;
  meanCitationsPerAnswer: number | null;
  maxCitationsPerAnswer: number | null;
} {
  const measured = scored.filter(
    (row) => row.answerChars !== undefined && row.citationCount !== undefined,
  );
  const chars = measured.map((row) => row.answerChars!);
  const citations = measured.map((row) => row.citationCount!);
  return {
    meanAnswerChars: meanOf(chars),
    maxAnswerChars: maxOrNull(chars),
    meanCitationsPerAnswer: meanOf(citations),
    maxCitationsPerAnswer: maxOrNull(citations),
  };
}

function maxOrNull(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((largest, x) => (x > largest ? x : largest));
}
