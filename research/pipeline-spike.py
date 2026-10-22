#!/usr/bin/env python3
"""End-to-end spike: the proposed pipeline over the whole Golden Set.

One question goes through the four stages the research supports:

  1. expand   — four topic queries, one hypothetical passage, one quoted passage (E6/E8/E9)
  2. union    — retrieve for each, dedupe by row id (E10)
  3. select   — rerank the union to five passages (E7)
  4. answer   — generate in Indonesian, quote per claim, cite [n] (E11)

and the answer is then checked by the deterministic quote checker.

This is a research spike, not the product pipeline: it calls the corpus directly and does not
write traces. Its number is indicative of the architecture, not a release measurement.

    python3 research/pipeline-spike.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-spike.json.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rewrite = _load("rewrite", "research/query-rewrite-probe.py")
multi = _load("multi", "research/multi-query-probe.py")
rerank_probe = _load("rerank", "research/union-rerank-probe.py")

ANSWER_PROMPT = """Sumber:
{passages}

Pertanyaan: {question}

Jawab dalam bahasa Indonesia, maksimal 90 kata. Setiap klaim harus disertai kutipan pendek
(dalam tanda kutip) dari salah satu sumber dan penandanya, misalnya: "…" [2]. Gunakan hanya
isi sumber di atas; jangan menambah pengetahuan lain. Jika sumber tidak memuat jawabannya,
katakan demikian secara singkat."""


def post(url: str, payload: dict, key: str) -> dict:
    for attempt in range(3):
        try:
            response = requests.post(url, headers={"Authorization": f"Bearer {key}"},
                                     json=payload, timeout=150)
            response.raise_for_status()
            return response.json()
        except Exception as error:  # noqa: BLE001 - retried, then surfaced
            if attempt == 2:
                raise
            print(f"  retry after {type(error).__name__}")
            time.sleep(2 + attempt * 3)
    raise RuntimeError("unreachable")


def one_question(question: str) -> dict:
    queries = multi.four_queries(question)
    hyde = post("https://api.deepseek.com/v1/chat/completions", {
        "model": "deepseek-chat", "temperature": 0,
        "messages": [{"role": "user", "content":
                       "Write the passage that would answer this question, in Indonesian, in the voice of a "
                       "Quran or hadith translation (max 40 words). No address, no explanation, only the passage.\n\n"
                       f"Question: {question}"}]},
        os.environ["DEEPSEEK_API_KEY"])["choices"][0]["message"]["content"].strip().replace("\n", " ")
    quote = post("https://api.deepseek.com/v1/chat/completions", {
        "model": "deepseek-chat", "temperature": 0,
        "messages": [{"role": "user", "content":
                       "Name the Quran verse or hadith that answers this question and write its Indonesian "
                       "translation as literally as you can. No address, no comment, only the translation.\n\n"
                       f"Question: {question}"}]},
        os.environ["DEEPSEEK_API_KEY"])["choices"][0]["message"]["content"].strip().replace("\n", " ")

    union: dict[str, dict] = {}
    for query in [question, *queries, hyde, quote]:
        for candidate in rerank_probe.topk(rewrite.embed(query), 12):
            union.setdefault(candidate["id"], candidate)
    pool = list(union.values())
    chosen = rerank_probe.rerank(question, pool)[:5]
    by_address = {candidate["address"]: candidate for candidate in pool}
    passages = [by_address[address] for address in chosen if address in by_address]
    if len(passages) < 3:
        passages = pool[:5]
    # Re-read the chosen rows in full: the union stage carries excerpts for ranking, but an
    # answer must see the whole chunk, and the checker must judge against it.
    for passage in passages:
        predicate = rewrite.locate(passage["address"])
        if predicate is None:
            continue
        full = rewrite.sql(
            f"""select regexp_replace(text_id, E'[\\n\\r\\t]+', ' ', 'g')
                from doc_children where {predicate} limit 1""")
        if full and full[0][0]:
            passage["text"] = full[0][0]

    listing = "\n".join(f"[{i + 1}] {candidate['address']} — {candidate['text'][:700]}"
                        for i, candidate in enumerate(passages))
    answer = post("https://api.deepseek.com/v1/chat/completions", {
        "model": "deepseek-chat", "temperature": 0,
        "messages": [{"role": "user", "content": ANSWER_PROMPT.format(
            passages=listing, question=question)}]},
        os.environ["DEEPSEEK_API_KEY"])["choices"][0]["message"]["content"].strip()
    return {"queries": len(union), "pool": len(pool), "answer": answer,
            "passages": [{"address": candidate["address"], "text": candidate["text"]}
                         for candidate in passages]}


def main() -> int:
    rewrite.load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    results = []
    for question in questions:
        print(f"== {question['id']} {question['question'][:60]}", flush=True)
        try:
            row = one_question(question["question"])
        except Exception as error:  # noqa: BLE001 - one bad question must not end the run
            print(f"   failed: {type(error).__name__}: {error}", flush=True)
            row = {"error": str(error)}
        row.update({"id": question["id"],
                    "required": (question.get("requiredCitations") or [None])[0],
                    "expected": question.get("expected")})
        results.append(row)
        print(f"   pool={row.get('pool')} passages={len(row.get('passages', []))} "
              f"answer={row.get('answer', '')[:70]}", flush=True)
    json.dump(results, open("/tmp/kq-spike.json", "w"), ensure_ascii=False, indent=1)
    print("wrote /tmp/kq-spike.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
