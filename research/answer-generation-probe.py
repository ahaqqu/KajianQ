#!/usr/bin/env python3
"""Probe: given the right evidence, does the answer cite it — and does its quote hold?

Every experiment so far measured retrieval. This measures generation: five passages, one of
which is the required row, and a product-shaped instruction to answer only from them with a
short quotation per claim. The quotations are then checked by the deterministic
`research/quote-fidelity.ts` (run separately), and the cited addresses are compared with the
gold address the question requires.

    python3 research/answer-generation-probe.py

Environment: GEMINI_API_KEY, DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-answers.json.
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

PROMPT = """Sumber:
{passages}

Pertanyaan: {question}

Jawab dalam bahasa Indonesia, maksimal 80 kata. Setiap klaim harus disertai kutipan pendek
(dalam tanda kutip) dari salah satu sumber dan penandanya, misalnya: "…" [2]. Gunakan hanya
isi sumber di atas; jangan menambah pengetahuan lain. Jika sumber tidak memuat jawabannya,
katakan demikian."""

PICK = ["gs-v0-002", "gs-v0-003", "gs-v0-006", "gs-v0-009", "gs-v0-010",
        "gs-v0-012", "gs-v0-014", "gs-v0-016", "gs-v0-017"]


def gold_text(predicate: str) -> tuple[str, str]:
    rows = module.sql(f"""select regexp_replace(text_id, E'[\\n\\r\\t]+', ' ', 'g'),
                                 metadata->>'sourceType' from doc_children
                          where {predicate} limit 1""")
    return rows[0][0], rows[0][1]


def neighbours(vector: str, predicate: str, k: int = 5) -> list[tuple[str, str]]:
    rows = module.sql(f"""
        select regexp_replace(text_id, E'[\\n\\r\\t]+', ' ', 'g'), metadata->>'sourceType'
        from doc_children
        where {predicate} and embedding_fallback is not null
        order by embedding_fallback <=> '{vector}'::vector limit {k}""")
    return [(row[0], row[1]) for row in rows]


def ask(question: str, passages: list[tuple[str, str]], addresses: list[str]) -> str:
    listing = "\n".join(f"[{i + 1}] {addresses[i]} — {text[:700]}"
                        for i, (text, _) in enumerate(passages))
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": PROMPT.format(
                  passages=listing, question=question)}]},
        timeout=120)
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"].strip()


def main() -> int:
    module.load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = {row["id"]: row for row in
                 (fixture["questions"] if isinstance(fixture, dict) else fixture)}
    results = []
    for qid in PICK:
        question = questions[qid]
        required = (question.get("requiredCitations") or [None])[0]
        if required is None:
            continue
        predicate = module.locate(required)
        text, source = gold_text(predicate)
        gold_vector = module.embed(text)
        distractor_predicate = ("metadata->>'sourceType' = 'quran'" if source == "quran"
                                else "metadata->>'sourceType' = 'hadith'")
        distractors = [row for row in neighbours(gold_vector, distractor_predicate, 6)
                       if row[0] != text][:4]
        passages = [(text, source), *distractors]
        addresses = [required] + [f"neighbour-{i + 1}" for i in range(len(distractors))]
        answer = ask(question["question"], passages, addresses)
        results.append({"id": qid, "required": required, "answer": answer,
                        "passages": [{"address": addresses[i], "text": passages[i][0]}
                                     for i in range(len(passages))]})
        print(f"{qid} {required:22} -> {answer[:90]}")
    json.dump(results, open("/tmp/kq-answers.json", "w"), ensure_ascii=False, indent=1)
    print("wrote /tmp/kq-answers.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
