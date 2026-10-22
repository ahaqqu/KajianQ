#!/usr/bin/env python3
"""Probe: can a model name the canonical address a question needs, before retrieval?

For every Golden Set question the model is asked for up to five candidate addresses with no
retrieval context. Each proposal is then checked against the corpus: does the row exist,
and is the question's required address among the proposals? That hit rate is the number
that decides whether an address-hypothesis stage is worth building.

    python3 research/address-hypothesis-probe.py

Environment: DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-address-proposals.json.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT = """You are helping an Islamic research assistant that answers only from a fixed corpus
of the Quran (Indonesian translation) and seven hadith collections (bukhari, muslim, nasai,
abudawud, ibmajah, tirmidhi, malik), numbered as on sunnah.com.

Question: {question}

List up to five specific addresses from that corpus that would answer the question.
Use exactly these forms: "QS. 2:255" for a verse, "HR. Bukhari no. 8" for a hadith.
Answer with a JSON array of strings and nothing else."""


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
        capture_output=True, text=True,
        env={**os.environ, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-400:])
    return [line.split("\t") for line in completed.stdout.splitlines()
            if line and line != "SET"]


def propose(question: str) -> list[str]:
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": PROMPT.format(question=question)}]},
        timeout=90)
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\[.*\]", raw, re.S)
    if not match:
        return []
    try:
        return [str(item) for item in json.loads(match.group(0))]
    except json.JSONDecodeError:
        return []


def exists(address: str) -> bool:
    verse = re.match(r"QS\.?\s*(\d+):(\d+)", address, re.I)
    hadith = re.match(r"HR\.?\s*([A-Za-z]+)\s*no\.?\s*(\d+)", address, re.I)
    if verse:
        surah, ayah = verse.groups()
        return bool(sql(f"""select 1 from doc_children where metadata->>'sourceType' = 'quran'
            and metadata->>'surah' = '{int(surah)}' and metadata->>'ayah' = '{int(ayah)}' limit 1"""))
    if hadith:
        collection, number = hadith.groups()
        return bool(sql(f"""select 1 from doc_children where metadata->>'sourceType' = 'hadith'
            and lower(citation->>'collection') = lower('{collection}')
            and citation->>'hadithNo' = '{number}' limit 1"""))
    return False


def normalise(address: str) -> str:
    verse = re.match(r"QS\.?\s*(\d+):(\d+)", address, re.I)
    if verse:
        return f"QS. {int(verse.group(1))}:{int(verse.group(2))}"
    hadith = re.match(r"HR\.?\s*([A-Za-z]+)\s*no\.?\s*(\d+)", address, re.I)
    if hadith:
        return f"HR. {hadith.group(1).lower()} no. {hadith.group(2)}"
    return address


def required_key(required: str) -> str:
    return normalise(required).lower()


def main() -> int:
    load_dotenv()
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    rows = []
    for question in questions:
        required = question.get("requiredCitations") or []
        proposals = propose(question["question"])
        proposals = [normalise(item) for item in proposals]
        flags = [(item, exists(item)) for item in proposals]
        hits = [item for item in proposals
                if required_key(item) in {required_key(r) for r in required}]
        rows.append({"id": question["id"], "required": required, "proposals": proposals,
                     "exists": [flag for _, flag in flags], "hit": bool(hits),
                     "hit_rank": (proposals.index(hits[0]) + 1) if hits else None})
        print(f"{question['id']} req={required} proposals={proposals} hit={bool(hits)}")
    total = len(rows)
    with_required = [row for row in rows if row["required"]]
    hit = [row for row in with_required if row["hit"]]
    existence = [flag for row in rows for flag in row["exists"]]
    summary = {
        "questions": total,
        "with_required": len(with_required),
        "required_named": len(hit),
        "top1": sum(1 for row in hit if row["hit_rank"] == 1),
        "proposals": len(existence),
        "proposals_exist": sum(existence),
    }
    print(json.dumps(summary, indent=1))
    json.dump({"rows": rows, "summary": summary},
              open("/tmp/kq-address-proposals.json", "w"), ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
