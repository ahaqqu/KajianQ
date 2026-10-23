#!/usr/bin/env bun
/**
 * Dump the production prompt strings and the decomposition behaviour into
 * `prompts.generated.json`, so the Python harness reads the exact text the
 * serving path sends instead of a hand-copied lookalike.
 *
 * Run from the research worktree:
 *   bun research/obligations/dump-prompts.mjs
 *
 * Read-only: it imports the domain pack and prints strings. No store, no
 * provider, no clock.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chatSystemPrompt,
  chatUserPrompt,
} from "../../packages/kajianq-domain/src/chat-prompts.ts";
import { ROUTER_SYSTEM_PROMPT } from "../../packages/kajianq-domain/src/chat-router-output.ts";
import { decomposeQuery } from "../../packages/kajianq-domain/src/chat-router-decompose.ts";
import { RERANK_INSTRUCTIONS } from "../../packages/kajianq-domain/src/decision-bench-prompts.ts";
import {
  DEFAULT_REFUSALS,
  REFUSAL_FLOORS,
} from "../../packages/kajianq-domain/src/chat-refusal.ts";

// One reading per shape the harness reproduces: the displacement case (a
// paraphrase occupies the only factual slot) and a four-role reading.
const DECOMPOSITION_CASES = [
  {
    question: "Apa yang Nabi Islam katakan tentang mencari ilmu?",
    needsPrinciple: false,
    principleTags: [],
    category: "hadith",
    modelSubQueries: [
      { text: "keutamaan mencari ilmu", role: "factual" },
      { text: "hadits tentang menuntut ilmu", role: "sanad" },
    ],
  },
  {
    question: "Apa beda ihsan dan iman?",
    needsPrinciple: false,
    principleTags: [],
    category: "aqidah",
    modelSubQueries: [
      { text: "perbedaan ihsan dan iman", role: "factual" },
      { text: "pengertian ihsan dalam islam", role: "factual" },
      { text: "pengertian iman dalam islam", role: "factual" },
    ],
  },
];

const out = {
  generatedBy: "research/obligations/dump-prompts.mjs",
  routerSystemPrompt: ROUTER_SYSTEM_PROMPT,
  chatSystemPrompt: { id: chatSystemPrompt("id"), en: chatSystemPrompt("en") },
  chatUserPrompt: chatUserPrompt("Pertanyaan contoh", "Konteks contoh"),
  rerankInstructions: RERANK_INSTRUCTIONS,
  refusals: DEFAULT_REFUSALS,
  refusalFloors: REFUSAL_FLOORS,
  decomposition: DECOMPOSITION_CASES.map((input) => ({
    input,
    subQueries: decomposeQuery(input),
  })),
};

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "prompts.generated.json");
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${target}`);
console.log(
  `router ${out.routerSystemPrompt.length} chars; decomposition cases ${out.decomposition.length}`,
);
