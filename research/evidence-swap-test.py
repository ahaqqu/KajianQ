#!/usr/bin/env python3
"""Swap test: may a model checker hold a gate seat on claim support?

For each claim the same checker sees four quotes: one that supports it, one that is a
parallel narration of the same report (different address), one from a topically adjacent
but non-supporting passage, and one that is the true quote with a minimal adversarial edit
(a negation inserted, a number changed). The number that decides the design is the
false-accept rate on the last two: any false accept means the checker cannot gate support.

    python3 research/evidence-swap-test.py

Environment: DEEPSEEK_API_KEY, PGPASSWORD. Writes /tmp/kq-swap-test.json.
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

PROMPT = """You are verifying a citation. Decide only whether the quoted evidence supports the
claim. Be strict: if the quote describes something else, a different ruling, a different
number, or the opposite of the claim, it does not support it.

Claim: {claim}
Cited address: {address}
Quote: {quote}

Answer with JSON only: {{"supports": true}} or {{"supports": false}}"""


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


def hadith(collection: str, number: str) -> str:
    row = sql(f"select text_id from doc_children where citation->>'collection' = '{collection}' "
              f"and citation->>'hadithNo' = '{number}' limit 1")
    return row[0][0] if row else ""


def verse(surah: int, ayah: int) -> str:
    row = sql(f"select text_id from doc_children where metadata->>'surah' = '{surah}' "
              f"and metadata->>'ayah' = '{ayah}' limit 1")
    return row[0][0] if row else ""


def around(text: str, keyword: str, before: int = 8, after: int = 16) -> str:
    """Quote the window around a keyword, so the quote carries the claim's content."""
    words = text.split()
    for index, word in enumerate(words):
        if keyword.lower() in word.lower():
            return " ".join(words[max(0, index - before):index + after])
    return ""


def edit(quote: str, old: str, new: str) -> str:
    """Apply a minimal meaning-flipping edit and refuse to silently no-op."""
    if old not in quote:
        raise ValueError(f"adversarial edit not applicable: {old!r}")
    return quote.replace(old, new, 1)


CASES = [
    {
        "claim": "Menjamak shalat saat safar diperbolehkan.",
        "address": "HR. Malik no. 326",
        "true": lambda: around(hadith("malik", "326"), "menjamak"),
        "parallel": lambda: around(hadith("nasai", "598"), "menjama"),
        "wrong": lambda: around(hadith("bukhari", "8"), "zakat"),
        "adversarial": lambda: edit(around(hadith("malik", "326"), "menjamak"),
                                    "menjamak", "tidak menjamak"),
    },
    {
        "claim": "Zakat wajib bagi setiap muslim.",
        "address": "HR. Bukhari no. 8",
        "true": lambda: around(hadith("bukhari", "8"), "zakat"),
        "parallel": lambda: around(hadith("bukhari", "25"), "zakat"),
        "wrong": lambda: around(verse(2, 275), "riba"),
        "adversarial": lambda: edit(around(hadith("bukhari", "8"), "zakat"),
                                    "menunaikan zakat", "tidak menunaikan zakat"),
    },
    {
        "claim": "Riba diharamkan.",
        "address": "QS. 2:275",
        "true": lambda: around(verse(2, 275), "riba", 4, 10),
        "parallel": lambda: around(verse(2, 278), "riba", 4, 10),
        "wrong": lambda: around(verse(2, 282), "utang", 4, 10),
        "adversarial": lambda: edit(around(verse(2, 275), "mengharamkan", 4, 10),
                                    "mengharamkan", "menghalalkan"),
    },
    {
        "claim": "Membaca Al-Quran mendatangkan pahala.",
        "address": "HR. Tirmidhi no. 2910",
        "true": lambda: around(hadith("tirmidhi", "2910"), "membaca", 6, 16),
        "parallel": lambda: around(hadith("bukhari", "5027"), "membaca", 6, 16),
        "wrong": lambda: around(hadith("bukhari", "8"), "zakat"),
        "adversarial": lambda: edit(around(hadith("tirmidhi", "2910"), "membaca", 6, 16),
                                    "Barangsiapa membaca", "Barangsiapa tidak membaca"),
    },
    {
        "claim": "Emas haram dipakai laki-laki.",
        "address": "HR. Ibnu Majah no. 3597",
        "true": lambda: around(hadith("ibnmajah", "3597"), "diharamkan", 6, 14),
        "parallel": lambda: around(hadith("nasai", "5144"), "emas", 6, 14),
        "wrong": lambda: around(hadith("bukhari", "8"), "zakat"),
        "adversarial": lambda: edit(around(hadith("ibnmajah", "3597"), "diharamkan", 6, 14),
                                    "diharamkan", "dihalalkan"),
    },
    {
        "claim": "Allah tidak menyerupai makhluk-Nya.",
        "address": "QS. 42:11",
        "true": lambda: around(verse(42, 11), "serupa", 6, 8),
        "parallel": lambda: around(verse(112, 4), "setara", 4, 8),
        "wrong": lambda: around(verse(2, 255), "tidur", 4, 10),
        "adversarial": lambda: edit(around(verse(42, 11), "serupa", 6, 8),
                                    "Tidak ada", "Ada"),
    },
]


def check(claim: str, address: str, quote: str) -> tuple[bool, str]:
    response = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": PROMPT.format(
                  claim=claim, address=address, quote=quote)}]},
        timeout=90)
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return False, raw[:80]
    try:
        return bool(json.loads(match.group(0)).get("supports")), raw[:80]
    except json.JSONDecodeError:
        return False, raw[:80]


def main() -> int:
    load_dotenv()
    rows = []
    for case in CASES:
        claim, address = case["claim"], case["address"]
        conditions = {
            "true": case["true"](),
            "parallel": case["parallel"](),
            "wrong-address": case["wrong"](),
            "adversarial": case["adversarial"](),
        }
        for label, quote in conditions.items():
            if not quote:
                print(f"{claim[:30]:32} {label:14} SKIPPED (no text)")
                continue
            supports, _ = check(claim, address, quote)
            rows.append({"claim": claim, "condition": label, "supports": supports,
                         "quote": quote[:160]})
            print(f"{claim[:30]:32} {label:14} supports={supports}")
    summary = {}
    for label in ("true", "parallel", "wrong-address", "adversarial"):
        cells = [row["supports"] for row in rows if row["condition"] == label]
        summary[label] = {"n": len(cells), "accepted": sum(cells)}
    print(json.dumps(summary, indent=1))
    json.dump({"rows": rows, "summary": summary}, open("/tmp/kq-swap-test.json", "w"),
              ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
