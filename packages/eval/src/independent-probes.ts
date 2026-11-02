import * as v from "valibot";
import { describeIssue } from "@app/contracts";
import { answerStats } from "./harness-outcomes";
import { CHAT_LANGUAGES, type CitationFrameLike, type CitationGrammar } from "./harness-types";
import { citationLabelsPresent } from "./scorers";

/**
 * The independent probe suite: a small fixture of known-answer questions, separate
 * from the Golden Set, whose pass rule is one expected citation set plus a short
 * content check. It exists for a quick, manual regression read on the handful of
 * canonical questions the independent check asked; it is NOT a Golden Set and its
 * runner applies none of that set's coverage floors.
 *
 * Everything here is deterministic and offline: parsing the fixture, folding the
 * answer text, scoring one answer, and rendering the run report. Only the caller
 * supplies answers, so unit tests never reach a model.
 */

/** One expected-content check: at least one of `anyOf` must appear as a whole
 * word or phrase in the folded answer. Several checks are ANDed. */
export const IndependentContentCheckSchema = v.object({
  label: v.pipe(v.string(), v.minLength(1)),
  anyOf: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
});

export const IndependentProbeSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  question: v.pipe(v.string(), v.minLength(1)),
  /** The language the question is asked in: one of the chat client's accepted
   * `language` values, validated here so a fixture cannot ask in a language the
   * client would silently map to another. */
  language: v.picklist(CHAT_LANGUAGES),
  /** The citations a passing answer must ground; all are required. */
  expectedCitations: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  /** Short content checks a passing answer must satisfy. */
  expectedContent: v.pipe(v.array(IndependentContentCheckSchema), v.minLength(1)),
});

export type IndependentProbe = v.InferOutput<typeof IndependentProbeSchema>;
export type IndependentContentCheck = v.InferOutput<typeof IndependentContentCheckSchema>;

export const IndependentProbeFixtureSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    probes: v.pipe(v.array(IndependentProbeSchema), v.minLength(1)),
  }),
  v.check(
    (fixture) => new Set(fixture.probes.map((probe) => probe.id)).size === fixture.probes.length,
    "probe ids must be unique",
  ),
);

export type IndependentProbeFixture = v.InferOutput<typeof IndependentProbeFixtureSchema>;

/** A loader failure with the fixture source and the valibot issues attached. A
 * malformed fixture fails the load, never a silent skip. */
export class IndependentProbeLoadError extends Error {
  constructor(
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(`independent probe fixture "${source}" failed validation: ${issues.join("; ")}`);
  }
}

/** Validate an already-parsed fixture object. */
export function parseIndependentProbes(raw: unknown, source = "inline"): IndependentProbeFixture {
  const parsed = v.safeParse(IndependentProbeFixtureSchema, raw);
  if (!parsed.success) {
    throw new IndependentProbeLoadError(source, parsed.issues.map(describeIssue));
  }
  return parsed.output;
}

/** Load a fixture from a JSON string (the CLI reads the file; this module stays
 * I/O-free for testability). */
export function loadIndependentProbesJson(
  json: string,
  source = "inline",
): IndependentProbeFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new IndependentProbeLoadError(source, [`invalid JSON: ${String(cause)}`]);
  }
  return parseIndependentProbes(raw, source);
}

/**
 * Fold text for a content check: compatibility-normalize, drop combining marks,
 * lower-case, and collapse punctuation/whitespace to single spaces. This is generic
 * Unicode work, not a language policy, so a spelling variant the fixture lists in
 * `anyOf` is what makes two forms equivalent.
 */
export function foldProbeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether one content check is satisfied: one of its terms appears as a whole
 * word/phrase in the folded answer. */
export function contentCheckPasses(check: IndependentContentCheck, answerText: string): boolean {
  const folded = ` ${foldProbeText(answerText)} `;
  return check.anyOf.some((term) => {
    const needle = foldProbeText(term);
    return needle !== "" && folded.includes(` ${needle} `);
  });
}

/** One answer as the live runner receives it. */
export type ProbeAnswer = { text: string; citations?: CitationFrameLike | null };

export type ProbeContentOutcome = { label: string; passed: boolean };

/** One probe's verdict and descriptive figures. `answerChars`/`citationCount` are
 * null exactly when that figure was never measured — no answer was read (a transport
 * failure), or the answer carried no citation-count source (no frame and no grammar) —
 * never for an empty answer, which is a measured 0. */
export type ProbeOutcome = {
  probeId: string;
  passed: boolean;
  answerChars: number | null;
  citationCount: number | null;
  missingCitations: string[];
  contentChecks: ProbeContentOutcome[];
  error?: string;
};

/**
 * Score one probe's answer. Citations use the same deterministic reader as the
 * Golden Set's citation validity, and the descriptive figures use the same
 * derivation as the eval report, so this suite cannot disagree with the harness
 * about what the answer carried.
 */
export function scoreProbe(
  probe: IndependentProbe,
  answer: ProbeAnswer,
  grammar?: CitationGrammar,
): ProbeOutcome {
  const present = citationLabelsPresent({
    required: probe.expectedCitations,
    answerText: answer.text,
    frame: answer.citations ?? null,
    ...(grammar !== undefined ? { grammar } : {}),
  });
  const contentChecks = probe.expectedContent.map((check) => ({
    label: check.label,
    passed: contentCheckPasses(check, answer.text),
  }));
  const stats = answerStats({
    answerText: answer.text,
    frame: answer.citations ?? null,
    ...(grammar !== undefined ? { grammar } : {}),
  });
  return {
    probeId: probe.id,
    passed:
      present.length === probe.expectedCitations.length && contentChecks.every((c) => c.passed),
    answerChars: stats.answerChars,
    citationCount: stats.citationCount ?? null,
    missingCitations: probe.expectedCitations.filter((citation) => !present.includes(citation)),
    contentChecks,
  };
}

/** The outcome for a probe whose transport failed: never asked, so no answer
 * figures and no claims about missing citations or content — only the cause. */
export function failedProbeOutcome(probe: IndependentProbe, err: unknown): ProbeOutcome {
  return {
    probeId: probe.id,
    passed: false,
    answerChars: null,
    citationCount: null,
    missingCitations: [],
    contentChecks: [],
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Ask one question and return its answer. Injected so offline tests exercise the
 * whole run without a model call. */
export type ProbeAsk = (probe: IndependentProbe) => Promise<ProbeAnswer>;

/**
 * Run every probe, keeping the suite going after a transport failure: one failed
 * call must not hide the other four verdicts. Exactly one outcome per fixture
 * probe, in fixture order.
 */
export async function runProbes(
  fixture: IndependentProbeFixture,
  ask: ProbeAsk,
  grammar?: CitationGrammar,
): Promise<ProbeOutcome[]> {
  const outcomes: ProbeOutcome[] = [];
  for (const probe of fixture.probes) {
    try {
      outcomes.push(scoreProbe(probe, await ask(probe), grammar));
    } catch (err) {
      outcomes.push(failedProbeOutcome(probe, err));
    }
  }
  return outcomes;
}

/** The per-probe report lines: verdict, answer length, citation count, and — on a
 * failure — the missed citations and content checks. */
export function formatProbeRun(
  fixture: IndependentProbeFixture,
  outcomes: readonly ProbeOutcome[],
): string[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.probeId, outcome]));
  const lines = [
    `eval:probes: ${fixture.id} — ${fixture.probes.length} independent probes (manual; not a Golden Set run)`,
  ];
  for (const probe of fixture.probes) {
    const outcome = byId.get(probe.id);
    if (outcome === undefined) {
      lines.push(`  MISSING ${probe.id} [${probe.language}] — no outcome recorded`);
      continue;
    }
    if (outcome.error !== undefined) {
      lines.push(`  FAIL ${probe.id} [${probe.language}] — error: ${outcome.error}`);
      continue;
    }
    const citations =
      outcome.citationCount === null
        ? "citations unmeasured"
        : outcome.citationCount === 1
          ? "1 citation"
          : `${outcome.citationCount} citations`;
    const evidence = `${outcome.answerChars} chars, ${citations}`;
    const missing =
      outcome.missingCitations.length > 0
        ? `; missing citations: ${outcome.missingCitations.join(", ")}`
        : "";
    const failedChecks = outcome.contentChecks.filter((check) => !check.passed);
    const content = `; content: ${outcome.contentChecks.length - failedChecks.length}/${outcome.contentChecks.length} checks${
      failedChecks.length > 0
        ? ` (failed: ${failedChecks.map((check) => check.label).join(", ")})`
        : ""
    }`;
    lines.push(
      `  ${outcome.passed ? "PASS" : "FAIL"} ${probe.id} [${probe.language}] — ${evidence}${missing}${content}`,
    );
  }
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const missing = fixture.probes.filter(
    (probe) => !outcomes.some((outcome) => outcome.probeId === probe.id),
  ).length;
  lines.push(
    `eval:probes: ${passed} passed, ${outcomes.length - passed} failed${missing > 0 ? `, ${missing} missing` : ""}`,
  );
  return lines;
}

/**
 * The exit verdict: green only when every **fixture** probe ran and passed. Pure, so
 * the live script's one effectful line stays trivial. The fixture is the expected
 * enumeration, not the outcome list: a truncated run fails with the probes it never
 * scored, because an unmeasured probe is not a pass.
 */
export function probeExitPolicy(
  fixture: IndependentProbeFixture,
  outcomes: readonly ProbeOutcome[],
): {
  ok: boolean;
  message: string;
} {
  const byId = new Map(outcomes.map((outcome) => [outcome.probeId, outcome]));
  const failed: string[] = [];
  const missing: string[] = [];
  for (const probe of fixture.probes) {
    const outcome = byId.get(probe.id);
    if (outcome === undefined) missing.push(probe.id);
    else if (!outcome.passed) failed.push(probe.id);
  }
  if (failed.length === 0 && missing.length === 0) {
    return { ok: true, message: "eval:probes: PASSED" };
  }
  const parts = [
    ...(failed.length > 0 ? [failed.join(", ")] : []),
    ...missing.map((id) => `${id} (no outcome recorded)`),
  ];
  return { ok: false, message: `eval:probes: FAILED — ${parts.join("; ")}` };
}
