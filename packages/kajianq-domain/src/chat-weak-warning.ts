import type { Chunk } from "@app/rag-core";
import { hasWeakChain, isnadEvidenceOf } from "./chat-isnad-evidence";

/**
 * The weak-evidence rule's copy and trigger, owned together because the one
 * predicate answers both "does the rule fire" (the citations frame's
 * `dhaifWarning` flag) and "which words say why" (the card the answer carries).
 * A passage graded weak and a passage whose transmission carries one weak row
 * are different claims, and the copy must not merge them.
 */

/** The dhaif warning line for a passage graded weak as a whole (ID/EN). */
export function dhaifWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof."
    : "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
}

/** The dhaif warning line for a passage whose transmission carries the weak row. */
export function dhaifChainWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] One of the cited hadith's transmission chains is graded weak (dhaif); see the chains below — it may not be used as a primary proof."
    : "[Peringatan] Salah satu sanad hadits yang dikutip berderajat lemah (dhaif); lihat jalur periwayatan di bawah — tidak dapat dijadikan dalil utama.";
}

/** The weak-grade label the ingestion writes into chunk metadata. */
const WEAK_GRADE = "dhaif";

/** What made the weak-evidence rule fire: the passage's grade or one of its rows. */
export type WeakGradeScope = "passage" | "chain";

/**
 * The weak-evidence trigger, at the precision the warning copy needs: the
 * passage's own flattened grade when any retrieved chunk carries it, otherwise a
 * weak row on the chunk's transmission evidence, otherwise `null`. A passage
 * grade outranks a weak row because the whole hadith — not one sanad — is then
 * the subject of the warning.
 */
export function weakGradeScope(chunks: readonly Chunk[]): WeakGradeScope | null {
  let chain = false;
  for (const chunk of chunks) {
    const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
    if (meta["grade"] === WEAK_GRADE) return "passage";
    const evidence = isnadEvidenceOf(chunk);
    if (evidence !== null && hasWeakChain(evidence)) chain = true;
  }
  return chain ? "chain" : null;
}

/**
 * True when any retrieved chunk carries the weak grade — as its flattened grade,
 * or on any of its stored transmission rows. The second half is what keeps a
 * passage whose corpus grade is sound but whose chains include a weak one
 * flagged: the warning is about the evidence retrieved, not about the one value
 * the ingester happened to consolidate.
 */
export function hasWeakGradeChunk(chunks: readonly Chunk[]): boolean {
  return weakGradeScope(chunks) !== null;
}

/**
 * True when the text already carries the product's own dhaif warning copy, in
 * either language or at either scope. Exported because this IS what the
 * citations frame's `dhaifWarning` flag means: one predicate, two readers, so
 * the delivered answer and the frame derived from it can never disagree about
 * whether the warning is present.
 *
 * The predicate is deliberately the COPY, not the grade vocabulary. The
 * deterministic evidence renders a weak-grade chunk's label as `(Dhaif)` —
 * `renderEvidenceChunk` appends the store's grade — and the generator is
 * instructed to reproduce the evidence's labels verbatim, so an answer whose
 * context carries a dhaif chunk contains the bare token `dhaif` for a reason
 * that is not a warning at all; suppressing on that token would switch the
 * control OFF on exactly the answers it exists for. Spec §2.2 makes the grade
 * flag an "Always" control so it does not depend on the model, so only the copy
 * suppresses; an informal weakness claim gains the canonical line exactly as an
 * informal "lemah" already did.
 */
export function hasWeakWarning(text: string): boolean {
  return (
    text.includes(dhaifWarning("id")) ||
    text.includes(dhaifWarning("en")) ||
    text.includes(dhaifChainWarning("id")) ||
    text.includes(dhaifChainWarning("en"))
  );
}
