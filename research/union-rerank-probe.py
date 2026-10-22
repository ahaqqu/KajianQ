#!/usr/bin/env python3
"""Probe: does a reranker realise the four-query union's oracle bound?

E6 put the required row inside some query's top 10 for 12 of 17 questions. This builds the
candidate set the product would actually see — the union of the user's query and four
rewrites, ten rows each — and asks a reranker to order it. Two conditions per question:

  A  candidates from the user's own query (today's shape)
  B  candidates from the user's query plus four rewrites (E6's shape)

The required row is a hit when it lands in the reranker's top five.

    python3 research/union-rerank-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-union-rerank3.json.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = importlib.util.spec_from_file_location(
    "rewrite", os.path.join(ROOT, "research/query-rewrite-probe.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

RERANK_PROMPT = """Question: {question}

Rank the passages below by how directly they answer the question. Prefer a passage that states
the ruling or the fact itself over one that merely shares the topic.

{passages}

Answer with a JSON array of at most five address strings, most relevant first, chosen only from
the list above."""


def excerpt(text: str, source: str) -> str:
    """Show the reranker the matn, not the chain: drop the bracketed narrator run first."""
    if source == "hadith":
        tail = text.rsplit("]", 1)[-1] if "]" in text else text
        tail = tail.lstrip(" ,.\t")
        if len(tail) > 60:
            return tail[:400]
    return text[:400]


def canonical(row: list[str]) -> str:
    if row[1] == "quran":
        return f"QS. {row[2]}:{row[3]}"
    return f"HR. {row[2]} no. {row[3]}"


def topk(vector: str, k: int = 10) -> list[dict]:
    rows = module.sql(f"""
        select id, metadata->>'sourceType',
               coalesce(nullif(metadata->>'surah',''), citation->>'collection'),
               coalesce(nullif(metadata->>'ayah',''), citation->>'hadithNo'),
               regexp_replace(coalesce(text_id,''), E'[\\n\\r\\t]+', ' ', 'g')
        from doc_children
        where embedding_fallback is not null
        order by embedding_fallback <=> '{vector}'::vector limit {k}""")
    out = []
    for row in rows:
        out.append({"id": row[0], "source": row[1], "a": row[2], "b": row[3],
                    "text": excerpt(row[4], row[1]), "address": canonical(row)})
    return out


def resolve(item: str, candidates: list[dict]) -> str | None:
    """The reranker answers with an index or an address; accept both, never guess."""
    text = str(item).strip()
    index = re.fullmatch(r"\[?(\d+)\]?", text)
    if index:
        position = int(index.group(1))
        return candidates[position]["address"] if position < len(candidates) else None
    wanted = key(text)
    for candidate in candidates:
        if key(candidate["address"]) == wanted:
            return candidate["address"]
    return None


def rerank(question: str, candidates: list[dict]) -> list[str]:
    listing = "\n".join(f"[{i}] {c['address']} — {c['text']}" for i, c in enumerate(candidates))
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": RERANK_PROMPT.format(
                  question=question, passages=listing)}]},
        timeout=120)
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\[.*\]", raw, re.S)
    if not match:
        return []
    try:
        items = [str(item) for item in json.loads(match.group(0))]
    except json.JSONDecodeError:
        return []
    resolved = [resolve(item, candidates) for item in items]
    return [address for address in resolved if address]


def key(address: str) -> str:
    verse = re.match(r"QS\.?\s*(\d+):(\d+)", address, re.I)
    if verse:
        return f"qs:{int(verse.group(1))}:{int(verse.group(2))}"
    hadith = re.match(r"HR\.?\s*([A-Za-z]+)\s*no\.?\s*(\d+)", address, re.I)
    if hadith:
        return f"hr:{hadith.group(1).lower()}:{hadith.group(2)}"
    return address.lower()


def main() -> int:
    module.load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = {row["id"]: row["question"]
                 for row in (fixture["questions"] if isinstance(fixture, dict) else fixture)}
    previous = json.load(open("/tmp/kq-multiquery.json", encoding="utf-8"))
    results = []
    for record in previous["rows"]:
        question = questions[record["id"]]
        required = key(record["required"])
        own = topk(module.embed(question))
        union: dict[str, dict] = {c["id"]: c for c in own}
        for query in record["queries"]:
            for candidate in topk(module.embed(query)):
                union.setdefault(candidate["id"], candidate)
        pool = list(union.values())
        a = rerank(question, own)
        b = rerank(question, pool)
        row = {"id": record["id"], "required": record["required"],
               "pool": len(pool), "a_top5": key(a[0]) if False else None,
               "own_hit": any(key(x) == required for x in a[:5]),
               "union_hit": any(key(x) == required for x in b[:5]),
               "own_rank": next((i + 1 for i, x in enumerate(a) if key(x) == required), None),
               "union_rank": next((i + 1 for i, x in enumerate(b) if key(x) == required), None),
               "in_pool": any(key(c["address"]) == required for c in pool)}
        results.append(row)
        print(f"{record['id']} {record['required']:22} pool={len(pool):2} "
              f"own_rank={row['own_rank']} union_rank={row['union_rank']} "
              f"in_pool={row['in_pool']}")
    summary = {
        "n": len(results),
        "in_pool": sum(1 for r in results if r["in_pool"]),
        "own_top5": sum(1 for r in results if r["own_hit"]),
        "union_top5": sum(1 for r in results if r["union_hit"]),
    }
    print(json.dumps(summary, indent=1))
    json.dump({"rows": results, "summary": summary}, open("/tmp/kq-union-rerank3.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
