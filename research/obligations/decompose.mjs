#!/usr/bin/env bun
/**
 * One-shot bridge to the production decomposition rule: reads a JSON array of
 * `{question, needsPrinciple, principleTags, category, modelSubQueries}` on
 * stdin and writes `decomposeQuery`'s output as JSON. The Python harness calls
 * this instead of copying the rule, so the baseline arm exercises the stage the
 * serving path runs.
 *
 *   echo '[{...}]' | bun research/obligations/decompose.mjs
 */
import { decomposeQuery } from "../../packages/kajianq-domain/src/chat-router-decompose.ts";

const parts = [];
for await (const chunk of Bun.stdin.stream()) parts.push(chunk);
const input = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
process.stdout.write(JSON.stringify(input.map((entry) => decomposeQuery(entry))));
