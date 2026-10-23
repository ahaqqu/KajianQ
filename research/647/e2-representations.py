#!/usr/bin/env python3
"""E2 — per-row reachability matrix for #647.

For each of the four rows, measure the exact cosine rank of the required address under every
candidate representation. Vectors come from one of three sources and the script records which:

  text   — one live embedding of a text (an extra embedding at query time unless it replaces
           the question, which the `kind` field states)
  stored — the curated row's own stored `embedding_primary`; zero embeddings, one address read
  llm    — a DeepSeek call produced the text, which is then embedded (one LLM call per query)

Runs read-only against the local corpus. Writes results to research/647/e2-results.json and
prints a markdown table. Never prints a key.

Usage:  set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e2-representations.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402

OUT = Path(__file__).parent / "e2-results.json"
LLM_MODEL = "deepseek-v4-flash"
LLM_URL = "https://api.deepseek.com/v1/chat/completions"

QUESTIONS = {
    "007": "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?",
    "008": "Hadits apa yang menyebutkan keutamaan membaca Al-Quran?",
    "011": "Sebutkan hadits tentang kebersihan itu sebagian dari iman!",
    "016": "Which hadith describes the obligations of Zakat, and what does it say?",
}

# Twin / alternative / neighbour addresses, from the identity fixture and the fixture's any-of set.
TWINS = {
    "011": [("tirmidhi", "3517"), ("ibnmajah", "280"), ("nasai", "2437")],
    "016": [("abudawud", "1584"), ("ibnmajah", "1783"), ("nasai", "2522"), ("nasai", "2435")],
    "008": [("bukhari", "5027"), ("bukhari", "4937")],  # any-of alternatives, not identities
    "007": [],
}
NEIGHBOURS = {
    "011": [("muslim", "533"), ("muslim", "535")],
    "016": [("bukhari", "1394"), ("bukhari", "1396")],
    "008": [("bukhari", "5025"), ("bukhari", "5027")],
    "007": [],  # Quran neighbours handled below
}
QURAN_NEIGHBOURS = ["42/10", "42/12"]
# Verses that state the same doctrine (tanzih / mukhalafat) in other words — candidate scope.
SIBLING_VERSES = ["112/4", "6/103", "59/22"]

# A concept paraphrase a curator could write, with no LLM and no verse text copied.
CONCEPTS = {
    "007": [
        "Sifat wajib bagi Allah dalam aqidah Ahlus Sunnah: tanzih, mukhalafat lil hawadits, "
        "Allah tidak menyerupai makhluk-Nya",
        "Aqidah Ahlus Sunnah tentang sifat Allah: Allah Maha Mendengar dan Maha Melihat, "
        "tidak ada yang setara dengan-Nya",
    ],
    "011": [
        "Sebutkan hadits tentang bersuci itu setengah dari iman!",
    ],
    "016": [
        "Hadits tentang kewajiban zakat: zakat diambil dari orang kaya dan diberikan kepada "
        "orang fakir",
    ],
    "008": [
        "Hadits keutamaan membaca Al-Quran: sebaik-baik orang adalah yang mempelajari "
        "Al-Quran dan mengajarkannya",
    ],
}

HYDE_PROMPT = (
    "Tulis satu paragraf pendek (2-3 kalimat) dalam bahasa Indonesia yang berbunyi seperti "
    "terjemahan ayat Al-Qur'an atau hadis yang akan menjawab pertanyaan ini. Jangan sebut nomor "
    "ayat atau hadis. Pertanyaan: {q}"
)
QUOTE_PROMPT = (
    "Tulis teks terjemahan Indonesia dari ayat Al-Qur'an atau hadis yang Anda yakini menjawab "
    "pertanyaan berikut. Tulis hanya teksnya, tanpa nomor ayat atau hadis, tanpa penjelasan. "
    "Pertanyaan: {q}"
)

SPEND = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}


def llm(prompt: str) -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        sys.exit("DEEPSEEK_API_KEY not set (source the root .env)")
    body = json.dumps({"model": LLM_MODEL,
                       "messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": 1500,
                       "reasoning_effort": "none"}).encode()
    req = urllib.request.Request(LLM_URL, data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    u = d.get("usage") or {}
    SPEND["calls"] += 1
    SPEND["prompt_tokens"] += u.get("prompt_tokens", 0)
    SPEND["completion_tokens"] += u.get("completion_tokens", 0)
    return (d["choices"][0]["message"]["content"] or "").strip()


def matn(text: str) -> str:
    """The quoted part of a row: after the last bracketed narrator when there is an isnad."""
    i = text.rfind("]")
    return text[i + 1:].lstrip(" ,؛:") if i > 0 else text


def hadith_spec(coll: str, no: str) -> dict:
    return {"kind": "hadith", "collection": coll, "hadithNo": no,
            "label": f"HR. {coll.title()} no. {no}"}


def quran_spec(s: str, a: str) -> dict:
    return {"kind": "quran", "surah": s, "ayah": a, "label": f"QS. {s}:{a}"}


def exists(spec: dict) -> bool:
    try:
        harness.target_row(spec)
        return True
    except SystemExit:
        return False


def add(rows: list[dict], row_id: str, rep: str, kind: str, text: str | None = None,
        spec: dict | None = None) -> None:
    rows.append({"row": row_id, "representation": rep, "kind": kind, "text": text,
                 "vectorFrom": spec["label"] if spec else None,
                 "spec": spec})


def build() -> list[dict]:
    rows: list[dict] = []
    for rid, q in QUESTIONS.items():
        tgt = harness.TARGETS[rid]
        row = harness.target_row(tgt)
        add(rows, rid, "verbatim-question", "text(0 extra: the user's own query)", q)
        add(rows, rid, "matn-quote", "text(oracle quote of the required row)", matn(row["text_id"]))
        for i, c in enumerate(CONCEPTS[rid]):
            add(rows, rid, f"concept-paraphrase-{i + 1}", "text(1 embedding, no LLM)", c)
        add(rows, rid, "hyde", "llm(1 call + 1 embedding)", HYDE_PROMPT.format(q=q))
        add(rows, rid, "quote-shape", "llm(1 call + 1 embedding)", QUOTE_PROMPT.format(q=q))
        add(rows, rid, "address-augmented", "text(1 embedding + address source)",
            f"{q} ({tgt['label']})")
        for coll, no in TWINS[rid]:
            if exists(hadith_spec(coll, no)):
                add(rows, rid, f"twin:{coll}-{no}", "stored(0 embeddings)", spec=hadith_spec(coll, no))
            else:
                add(rows, rid, f"twin:{coll}-{no}", "MISSING-ADDRESS", spec=hadith_spec(coll, no))
        for coll, no in NEIGHBOURS[rid]:
            if exists(hadith_spec(coll, no)):
                add(rows, rid, f"neighbour:{coll}-{no}", "stored(0 embeddings)",
                    spec=hadith_spec(coll, no))
            else:
                add(rows, rid, f"neighbour:{coll}-{no}", "MISSING-ADDRESS", spec=hadith_spec(coll, no))
        if rid == "007":
            for na in QURAN_NEIGHBOURS:
                s, a = na.split("/")
                add(rows, rid, f"neighbour:quran-{s}:{a}", "stored(0 embeddings)",
                    spec=quran_spec(s, a))
            for na in SIBLING_VERSES:
                s, a = na.split("/")
                if exists(quran_spec(s, a)):
                    add(rows, rid, f"sibling-verse:{s}:{a}", "stored(0 embeddings)",
                        spec=quran_spec(s, a))
                else:
                    add(rows, rid, f"sibling-verse:{s}:{a}", "MISSING-ADDRESS",
                        spec=quran_spec(s, a))
    return rows


def run(rows: list[dict]) -> list[dict]:
    results = []
    for i, r in enumerate(rows):
        if r["kind"].startswith("MISSING"):
            results.append({**{k: r[k] for k in ("row", "representation", "kind")},
                            "missing": True})
            continue
        if r["kind"].startswith("llm"):
            text = llm(r["text"])
            r["llmOutput"] = text
            vec = harness.embed([text])[0]
        elif r["kind"].startswith("stored"):
            row = harness.target_row(r["spec"])
            vec = harness.row_vector(row["id"])
        else:
            vec = harness.embed([r["text"]])[0]
        res = harness.rank_of(vec, harness.TARGETS[r["row"]], k=50)
        in_top = [c for c in res["top"] if harness.addr(c["citation"]) ==
                  harness.TARGETS[r["row"]]["label"]]
        results.append({
            "row": r["row"], "representation": r["representation"], "kind": r["kind"],
            "rank": res["rank"], "total": res["total"],
            "rankWithinType": res["rankWithinType"],
            "totalWithinType": res["totalWithinType"],
            "cosine": round(res["cosine"], 4),
            "top10": res["rank"] <= 10, "top50": res["rank"] <= 50,
            "cosineInTop": in_top[0]["cosine"] if in_top else None,
            "queryText": r.get("llmOutput") or r.get("text"),
            "vectorFrom": r.get("vectorFrom"),
        })
        print(f"  {i + 1}/{len(rows)} {r['row']} {r['representation']}: "
              f"rank {res['rank']} (within type {res['rankWithinType']})")
    return results


def main() -> None:
    print("building representations ...")
    rows = build()
    print(f"running {len(rows)} representations ...")
    results = run(rows)
    OUT.write_text(json.dumps({"spend": SPEND, "results": results}, indent=1))
    print(f"\nspend: {SPEND['calls']} LLM calls, "
          f"{SPEND['prompt_tokens']} prompt + {SPEND['completion_tokens']} completion tokens")
    print("\n| row | representation | source | rank / 42511 | rank within type | cos | top-10 |")
    print("|---|---|---|---:|---:|---:|:--:|")
    for r in results:
        if r.get("missing"):
            print(f"| {r['row']} | {r['representation']} | MISSING | — | — | — | — |")
            continue
        print(f"| {r['row']} | {r['representation']} | {r['kind']} | {r['rank']} | "
              f"{r['rankWithinType']}/{r['totalWithinType']} | {r['cosine']} | "
              f"{'yes' if r['top10'] else 'no'} |")


if __name__ == "__main__":
    main()
