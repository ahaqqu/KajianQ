#!/usr/bin/env python3
"""Probe: if one rewrite is a lottery, does asking for several and taking the union help?

E5 measured a single rewrite call as a wash (top-10 6 -> 7, top-50 12 -> 11) with several
rows badly displaced. This asks the same model for four differently-worded queries and
reports (a) the best rank any of them achieves — the oracle bound for a reranked union —
and (b) whether fusing four independent queries can even contain the row.

    python3 research/multi-query-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-multiquery.json.
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
rewrite_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rewrite_module)

PROMPT = """Write FOUR different short search queries (max 18 words each) that would find the
passage answering the question below, in an Indonesian corpus of Quran and hadith
translations. Vary the wording: one using classical/doctrinal terms, one using plain modern
Indonesian, one naming the likely subject of the passage, one quoting a phrase the passage
might contain. Output a JSON array of four strings and nothing else.

Question: {question}"""


def four_queries(question: str) -> list[str]:
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0.6,
              "messages": [{"role": "user", "content": PROMPT.format(question=question)}]},
        timeout=120)
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\[.*\]", raw, re.S)
    if not match:
        return [question]
    try:
        queries = [str(item) for item in json.loads(match.group(0))]
    except json.JSONDecodeError:
        return [question]
    return queries[:4] or [question]


def main() -> int:
    rewrite_module.load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    results = []
    for question in questions:
        required = question.get("requiredCitations") or []
        if not required:
            continue
        predicate = rewrite_module.locate(required[0])
        if predicate is None:
            continue
        queries = four_queries(question["question"])
        ranks = [rewrite_module.rank(rewrite_module.embed(query), predicate) for query in queries]
        results.append({"id": question["id"], "required": required[0], "queries": queries,
                        "ranks": ranks, "best": min(r for r in ranks if r is not None)
                        if any(r is not None for r in ranks) else None})
        print(f"{question['id']} {required[0]:24} ranks={ranks} best={results[-1]['best']}")
    summary = {
        "n": len(results),
        "best_top10": sum(1 for row in results if row["best"] is not None and row["best"] <= 10),
        "best_top50": sum(1 for row in results if row["best"] is not None and row["best"] <= 50),
    }
    print(json.dumps(summary, indent=1))
    json.dump({"rows": results, "summary": summary}, open("/tmp/kq-multiquery.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
