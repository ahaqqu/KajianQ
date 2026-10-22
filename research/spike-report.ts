/**
 * Report the end-to-end spike: did the selected passages carry the required evidence, and did
 * the answer quote them honestly?
 *
 * Reads `/tmp/kq-spike.json` from `research/pipeline-spike.py`. Two numbers per question:
 * coverage (the required address is among the five selected passages) and quote fidelity
 * (each quoted span appears in the passage its `[n]` marker points at).
 *
 *   bun research/spike-report.ts
 */

import { addressKey } from "./evidence-units";

/** The full text of the chunk an address points at, read straight from the corpus. */
const fullText = new Map<string, string>();
function sourceText(address: string): string {
  const cached = fullText.get(addressKey(address));
  if (cached !== undefined) return cached;
  const verse = /^qs:(\d+):(\d+)$/u.exec(addressKey(address));
  const hadith = /^hr:([a-z']+):(\d+)$/u.exec(addressKey(address));
  if (verse === null && hadith === null) return "";
  const predicate =
    verse !== null
      ? `metadata->>'sourceType' = 'quran' and metadata->>'surah' = '${verse[1]}' and metadata->>'ayah' = '${verse[2]}'`
      : `metadata->>'sourceType' = 'hadith' and lower(citation->>'collection') = lower('${hadith?.[1]}') and citation->>'hadithNo' = '${hadith?.[2]}'`;
  const result = Bun.spawnSync(
    [
      "psql",
      "-h",
      "127.0.0.1",
      "-p",
      "55432",
      "-U",
      "postgres",
      "-d",
      "kajianq",
      "-tA",
      "-c",
      `SET default_transaction_read_only = on; select regexp_replace(text_id, E'[\\n\\r\\t]+', ' ', 'g') from doc_children where ${predicate} limit 1`,
    ],
    { env: { ...process.env, PGPASSWORD: "kq" } },
  );
  const text =
    result.stdout
      .toString()
      .split("\n")
      .filter((line) => line !== "SET" && line.length > 0)[0] ?? "";
  fullText.set(addressKey(address), text);
  return text;
}
import { quoteIsFaithful, quotedSpans } from "./quote-fidelity";

type Passage = { address: string; text: string };
type Row = {
  id: string;
  required: string | null;
  answer: string;
  passages: Passage[];
  error?: string;
};

const rows = (await Bun.file("/tmp/kq-spike.json").json()) as Row[];
const MARKER = /^\s*\[\s*(\d)\s*\]/u;
const HEDGE = /tidak (memuat|menjelaskan|disebutkan|menyebut|ada)|tidak dijelaskan|sumber hanya/iu;

let covered = 0;
let answered = 0;
let hedged = 0;
let quotes = 0;
let faithful = 0;
let unattributed = 0;
let misattributed = 0;
let fabricated = 0;

for (const row of rows) {
  if (row.error !== undefined || row.required === null) {
    console.log(`${row.id} ERROR ${row.error ?? "no requirement"}`);
    continue;
  }
  answered += 1;
  const hit = row.passages.some(
    (passage) => addressKey(passage.address) === addressKey(row.required as string),
  );
  if (hit) covered += 1;
  if (HEDGE.test(row.answer)) hedged += 1;
  let rowFaithful = 0;
  let rowBad = 0;
  for (const span of quotedSpans(row.answer)) {
    const marker = MARKER.exec(row.answer.slice(span.end));
    const target = marker === null ? undefined : row.passages[Number(marker[1]) - 1];
    quotes += 1;
    const full = target === undefined ? "" : sourceText(target.address);
    if (
      target !== undefined &&
      (quoteIsFaithful(span.quote, target.text) || quoteIsFaithful(span.quote, full))
    ) {
      faithful += 1;
      rowFaithful += 1;
      continue;
    }
    if (
      row.passages.some(
        (passage) =>
          quoteIsFaithful(span.quote, passage.text) ||
          quoteIsFaithful(span.quote, sourceText(passage.address)),
      )
    ) {
      if (target === undefined) unattributed += 1;
      else misattributed += 1;
    } else {
      fabricated += 1;
    }
    rowBad += 1;
  }
  console.log(
    `${row.id} covered=${hit} hedged=${HEDGE.test(row.answer)} quotes=${rowFaithful + rowBad} ` +
      `faithful=${rowFaithful} bad=${rowBad}`,
  );
}

console.log(
  JSON.stringify(
    {
      questions: rows.length,
      answered,
      coveredSelected: covered,
      hedged,
      quotes,
      faithful,
      unattributed,
      misattributed,
      fabricated,
    },
    null,
    1,
  ),
);
