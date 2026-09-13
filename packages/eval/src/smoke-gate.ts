/**
 * Smoke-gate exit policy — the staging post-merge smoke's fail threshold.
 *
 * The smoke gates a *live LLM pipeline*, where a single borderline answer
 * (e.g. a grounded-unanswerable reply to a refusal trap) can flip one
 * question nondeterministically between runs. The gate therefore tolerates a
 * small number of bad questions: `maxBad` counts failed AND skipped questions
 * (a skip is a transport-level transient by the harness contract) and the run
 * still fails above it, so a real regression — or a pipeline outage, which
 * skips every question — stays loud. `maxBad = 0` reproduces the original
 * zero-tolerance gate. Tolerance is never silent: the caller must print the
 * bad question ids when a run passes via tolerance, and a failure that
 * recurs every run is a real regression the tolerance merely stopped from
 * gating.
 */

export type SmokeGateDecision = {
  /** true when the run may exit 0 */
  pass: boolean;
  /** true when `pass` was granted by tolerance rather than a clean run */
  tolerated: boolean;
};

export function decideSmokeGate(
  failed: number,
  skipped: number,
  maxBad: number,
): SmokeGateDecision {
  const bad = failed + skipped;
  return { pass: bad <= maxBad, tolerated: bad > 0 && bad <= maxBad };
}
