#!/usr/bin/env python3
"""Probe: does a hypothetical answer passage (HyDE) reach rows that query rewrites cannot?

E6's four topic-shaped rewrites left QS. 42:11 at rank 230-463. The agentic probe reached it
third of five with a *phrase from the verse itself*. HyDE asks the model to write the passage
that would answer the question, then retrieves with that passage — a cheap stand-in for the
phrase-level query, without letting the model state an address.

    python3 research/hyde-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-hyde.json.
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

PROMPT = """Write the passage that would answer the question below, in Indonesian, in the voice
of a Quran translation or a hadith translation (one or two sentences, max 40 words). Do not
explain, do not give an address, do not mention that you are writing a passage. Output only
the passage.

Question: {question}"""


def hypothetical(question: str) -> str:
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
        open("/tmp/kq-multiquery.json", encoding="utf-8"))["rows"]}
    results = []
    for question in questions:
        required = question.get("requiredCitations") or []
        if not required or question["id"] not in previous:
            continue
        predicate = module.locate(required[0])
        if predicate is None:
            continue
        passage = hypothetical(question["question"])
        rank = module.rank(module.embed(passage), predicate)
        results.append({"id": question["id"], "required": required[0], "passage": passage,
                        "rank": rank, "best_of_four": previous[question["id"]]["best"]})
        print(f"{question['id']} {required[0]:22} hyde={rank} best4={results[-1]['best_of_four']}")
    summary = {
        "n": len(results),
        "hyde_top10": sum(1 for r in results if r["rank"] is not None and r["rank"] <= 10),
        "hyde_top50": sum(1 for r in results if r["rank"] is not None and r["rank"] <= 50),
        "best4_top10": sum(1 for r in results if r["best_of_four"] is not None
                           and r["best_of_four"] <= 10),
    }
    print(json.dumps(summary, indent=1))
    json.dump({"rows": results, "summary": summary}, open("/tmp/kq-hyde.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
