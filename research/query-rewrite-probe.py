#!/usr/bin/env python3
"""Probe: does one query-rewrite call beat the user's own wording?

The agentic probe found the model reformulating a doctrine question into scripture vocabulary
and reaching QS. 42:11 third of five. This measures the cheap, deployable version of that
mechanism: a single rewrite call, no tools, no loop, and the resulting rank of the row each
question requires.

    python3 research/query-rewrite-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-rewrite.json.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PATH": "/usr/bin:/bin:/usr/local/bin"}

PROMPT = """Rewrite the question below as ONE short search query (max 20 words) for an
Indonesian corpus of the Quran translation and hadith translations. Use the vocabulary that
would appear in those texts — classical terms, doctrinal phrases, named practices — not the
words of a modern chat question. Output only the query.

Question: {question}"""


def load_dotenv() -> None:
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def sql(query: str) -> list[list[str]]:
    completed = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "kajianq",
         "-tA", "-F", "\t", "-c", "SET default_transaction_read_only = on; " + query],
        capture_output=True, text=True, env=ENV)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-300:])
    return [line.split("\t") for line in completed.stdout.splitlines()
            if line and line != "SET"]


def embed(text: str) -> str:
    response = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
        headers={"Authorization": f"Bearer {os.environ['GEMINI_API_KEY']}"},
        json={"model": "gemini-embedding-001", "input": [text], "dimensions": 1536},
        timeout=90)
    response.raise_for_status()
    values = response.json()["data"][0]["embedding"]
    return "[" + ",".join(f"{value:.6f}" for value in values) + "]"


def rewrite(question: str) -> str:
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": PROMPT.format(question=question)}]},
        timeout=90)
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"].strip().replace("\n", " ")


def locate(citation: str) -> str | None:
    """The SQL predicate that identifies the required row, or None when unparseable."""
    verse = re.match(r"QS\.?\s*(\d+):(\d+)", citation, re.I)
    if verse:
        return (f"metadata->>'sourceType' = 'quran' and metadata->>'surah' = '{int(verse.group(1))}'"
                f" and metadata->>'ayah' = '{int(verse.group(2))}'")
    hadith = re.match(r"HR\.?\s*([A-Za-z]+)\s*no\.?\s*(\d+)", citation, re.I)
    if hadith:
        return (f"metadata->>'sourceType' = 'hadith'"
                f" and lower(citation->>'collection') = lower('{hadith.group(1)}')"
                f" and citation->>'hadithNo' = '{hadith.group(2)}'")
    return None


def rank(vector: str, predicate: str) -> int | None:
    """1-based rank of the required row among rows of its own source type, or None."""
    rows = sql(f"""
        select count(*) from doc_children c,
          (select embedding_fallback as e, metadata->>'sourceType' as st
             from doc_children where {predicate} limit 1) t
        where c.metadata->>'sourceType' = t.st
          and (c.embedding_fallback <=> '{vector}'::vector) < ('{vector}'::vector <=> t.e)""")
    if not rows or rows[0][0] == "":
        return None
    total = sql(f"""select count(*) from doc_children where metadata->>'sourceType' =
        (select metadata->>'sourceType' from doc_children where {predicate} limit 1)""")
    exists = sql(f"select count(*) from doc_children where {predicate}")
    if not exists or int(exists[0][0]) == 0:
        return None
    return int(rows[0][0]) + 1


def main() -> int:
    load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    results = []
    for question in questions:
        required = question.get("requiredCitations") or []
        if not required:
            continue
        predicate = locate(required[0])
        if predicate is None:
            continue
        query = rewrite(question["question"])
        before = rank(embed(question["question"]), predicate)
        after = rank(embed(query), predicate)
        results.append({"id": question["id"], "required": required[0], "query": query,
                        "before": before, "after": after})
        print(f"{question['id']} {required[0]:24} before={before} after={after}  q={query[:70]}")
    def hits(key: str, limit: int) -> int:
        return sum(1 for row in results if row[key] is not None and row[key] <= limit)
    summary = {"n": len(results), "top10_before": hits("before", 10),
               "top10_after": hits("after", 10), "top50_before": hits("before", 50),
               "top50_after": hits("after", 50)}
    print(json.dumps(summary, indent=1))
    json.dump({"rows": results, "summary": summary}, open("/tmp/kq-rewrite.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
