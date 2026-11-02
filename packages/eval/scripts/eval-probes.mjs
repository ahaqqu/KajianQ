#!/usr/bin/env bun
/**
 * eval-probes.mjs — the independent five-probe regression run (`bun run eval:probes`).
 *
 * A separate, manual suite for the five questions the independent check asked. It
 * is NOT the Golden Set: it reads its own fixture, applies none of the Golden Set's
 * coverage floors, writes no eval ledger row, and is never run in CI. Each probe
 * must ground its expected citation(s) and satisfy a short content check; the run
 * prints pass/fail, answer length and citation count per probe and exits non-zero
 * when any probe fails.
 *
 * Env (validated before any spend):
 *   EVAL_API_BASE_URL        the staging /v1/chat origin (required)
 *   EVAL_API_TOKEN           an anonymous Bearer token (required)
 *   EVAL_PROBE_FIXTURE_PATH  optional fixture override (defaults to the domain
 *                            pack's independent-probes-v1.json)
 *
 * Cost: exactly one chat answer per probe — the default fixture asks five — so the
 * spend is the pipeline cost of five answers (retrieval, generation and the
 * reviewer calls that answer needs). No ledger, no replay, no follow-up spend. A
 * budget cap is not applicable here because the run reads no trace cost; the
 * bounded probe count is the cap. Do not add this command to CI: it is the manual
 * evidence path, not a gate.
 *
 * The fixture parse/scoring/report logic lives in `@app/eval` and is covered
 * offline; this script is only the network loop and the exit code.
 */
import { readFileSync } from "node:fs";
import * as evalpkg from "@app/eval";
import { CITATION_GRAMMAR } from "./citation-grammar.mjs";

function fail(msg) {
  console.error(`eval:probes: ${msg}`);
  process.exit(1);
}

let config;
let fixture;
try {
  config = evalpkg.loadEvalProbeConfig(process.env);
  fixture = evalpkg.loadIndependentProbesJson(
    readFileSync(`${process.cwd()}/${config.probePath}`, "utf8"),
    config.probePath,
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const outcomes = await evalpkg.runProbes(
  fixture,
  async (probe) => {
    const reply = await evalpkg.postChatSse({
      baseUrl: config.apiBaseUrl,
      token: config.apiToken,
      question: probe.question,
      language: probe.language === "en" ? "en" : "id",
    });
    return { text: reply.text, citations: reply.citations };
  },
  CITATION_GRAMMAR,
);

for (const line of evalpkg.formatProbeRun(fixture, outcomes)) console.log(line);

const verdict = evalpkg.probeExitPolicy(outcomes);
if (verdict.ok) {
  console.log(verdict.message);
} else {
  console.error(verdict.message);
  process.exit(1);
}
