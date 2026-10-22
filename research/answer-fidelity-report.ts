/**
 * Report: what the generated answers actually did with the evidence they were given.
 *
 * Reads `/tmp/kq-answers.json` (written by `research/answer-generation-probe.py`), where each
 * question was answered over one gold passage plus four neighbours. Three questions are asked
 * of each answer:
 *
 *   1. Is each quoted span faithful to **the passage it points at** with its `[n]` marker —
 *      not merely to some passage in the batch? Misattribution and fabrication are different
 *      failures and the report keeps them apart.
 *   2. Does the answer name the address the Golden Set requires?
 *   3. Does it name an address that was never in its context?
 *
 *   bun research/answer-fidelity-report.ts
 */

import { addressKey } from "./evidence-units";
import { checkAnswer, quoteIsFaithful, quotedSpans } from "./quote-fidelity";

type Passage = { address: string; text: string };
type Answer = { id: string; required: string; answer: string; passages: Passage[] };

const answers = (await Bun.file("/tmp/kq-answers.json").json()) as Answer[];

const MARKER = /^\s*\[\s*(\d)\s*\]/u;
const ADDRESS = /QS\.?\s*\d+:\d+|HR\.?\s+[A-Za-z]+\s+no\.?\s*\d+/gu;

let quotes = 0;
let faithful = 0;
let unattributed = 0;
let misattributed = 0;
let fabricated = 0;
let namedRequired = 0;
let usedGold = 0;
let inventedAddresses = 0;

for (const row of answers) {
  const passages = row.passages;
  const known = new Set(passages.map((passage) => addressKey(passage.address)));
  const quoted = quotedSpans(row.answer).map((span) => {
    const marker = MARKER.exec(row.answer.slice(span.end));
    return { quote: span.quote, marker: marker?.[1] };
  });
  let rowFaithful = 0;
  let rowUnattributed = 0;
  let rowMisattributed = 0;
  let rowFabricated = 0;
  for (const match of quoted) {
    const quote = match.quote;
    const marker = match.marker === undefined ? undefined : Number(match.marker) - 1;
    const target = marker === undefined ? undefined : passages[marker];
    quotes += 1;
    if (target !== undefined && quoteIsFaithful(quote, target.text)) {
      faithful += 1;
      rowFaithful += 1;
      continue;
    }
    // The words exist somewhere in the batch: either no marker at all, or a marker that
    // points away from the passage that actually contains them.
    if (passages.some((passage) => quoteIsFaithful(quote, passage.text))) {
      if (marker === undefined) {
        unattributed += 1;
        rowUnattributed += 1;
      } else {
        misattributed += 1;
        rowMisattributed += 1;
      }
    } else {
      fabricated += 1;
      rowFabricated += 1;
    }
  }
  const goldMarker = /\[\s*1\s*\]/u.test(row.answer);
  if (goldMarker) usedGold += 1;
  const named = [...row.answer.matchAll(ADDRESS)].map((match) => match[0]);
  const requiredNamed = named.some((address) => addressKey(address) === addressKey(row.required));
  if (requiredNamed) namedRequired += 1;
  const invented = named.filter((address) => !known.has(addressKey(address)));
  inventedAddresses += invented.length;
  const global = checkAnswer(
    row.answer,
    passages.map((passage, index) => ({
      label: String(index + 1),
      text: passage.text,
    })),
  );
  console.log(
    `${row.id} quotes=${quoted.length} faithful=${rowFaithful} unattributed=${rowUnattributed} ` +
      `misattributed=${rowMisattributed} ` +
      `fabricated=${rowFabricated} namesRequired=${requiredNamed} invented=${invented.length} ` +
      `checkAnswerUnverifiable=${global.filter((v) => v.status === "unverifiable").length}`,
  );
}

console.log(
  JSON.stringify(
    {
      answers: answers.length,
      quotes,
      faithful,
      unattributed,
      misattributed,
      fabricated,
      citedPassage1: usedGold,
      inventedAddresses,
    },
    null,
    1,
  ),
);
