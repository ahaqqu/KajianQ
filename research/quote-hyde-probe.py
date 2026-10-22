#!/usr/bin/env python3
"""Probe: a *quote-shaped* hypothetical passage — the verse's own words as the query.

E8's hypothetical passage for the doctrine question came back in scholarly vocabulary
(wujud, qidam, mukhalafatu lil hawaditsi) that the Quran translation does not use, and it
ranked 582nd. The agentic probe instead reached the verse with a phrase from the verse
itself. This asks the model for the literal Indonesian rendering of the passage it believes
answers the question — text only, never an address — and retrieves with it.

    python3 research/quote-hyde-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-quotehyde.json.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = importlib.util.spec_from_file_location(
    "rewrite", os.path.join(ROOT, "research/query-rewrite-probe.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

PROMPT = """Below is a question about Islam. Name the single Quran verse or hadith that answers
it, and write its Indonesian translation as literally as you can — the way the Indonesian
translation of the Quran or of a hadith collection renders it. Do not give the address. Do not
comment. If you are unsure, write the closest passage you know.

Question: {question}

Output only the translation text."""


def quote_passage(question: str) -> str:
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": PROMPT.format(question=question)}]},
        timeout=90)
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"].strip().replace("\n", " ")


def main() -> int:
    module.load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    previous = {row["id"]: row for row in json.load(
        open("/tmp/kq-hyde.json", encoding="utf-8"))["rows"]}
    results = []
    for question in questions:
        required = question.get("requiredCitations") or []
        if not required or question["id"] not in previous:
            continue
        predicate = module.locate(required[0])
        if predicate is None:
            continue
        passage = quote_passage(question["question"])
        rank = module.rank(module.embed(passage), predicate)
        results.append({"id": question["id"], "required": required[0], "passage": passage,
                        "rank": rank, "hyde_rank": previous[question["id"]]["rank"]})
        print(f"{question['id']} {required[0]:22} quote-hyde={rank} hyde={results[-1]['hyde_rank']}")
    summary = {
        "n": len(results),
        "top10": sum(1 for r in results if r["rank"] is not None and r["rank"] <= 10),
        "top50": sum(1 for r in results if r["rank"] is not None and r["rank"] <= 50),
    }
    print(json.dumps(summary, indent=1))
    json.dump({"rows": results, "summary": summary}, open("/tmp/kq-quotehyde.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
