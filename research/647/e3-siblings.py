#!/usr/bin/env python3
"""E3 — which sibling does the verbatim question actually retrieve?

If the user's own wording puts an address the identity map (or the fixture's any-of set) already
accepts inside the top-K, the row needs no new representation: D1/D3 plus the existing retriever
is enough. This measures, for each of the four rows, the rank of every sibling address under the
*verbatim question's* vector — zero vendor calls when the vector is already cached.

Usage: set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e3-siblings.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402

QUESTIONS = {
    "007": "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?",
    "008": "Hadits apa yang menyebutkan keutamaan membaca Al-Quran?",
    "011": "Sebutkan hadits tentang kebersihan itu sebagian dari iman!",
    "016": "Which hadith describes the obligations of Zakat, and what does it say?",
}

# Siblings a gate may already accept: identity members (fixture) and the fixture's any-of set.
SIBLINGS = {
    "007": ["42/9", "42/10", "42/11", "42/12", "6/103", "112/4", "59/22"],
    "008": ["bukhari/5025", "bukhari/5026", "bukhari/5027", "bukhari/5028", "bukhari/4937"],
    "011": ["muslim/534", "tirmidhi/3517", "ibnmajah/280", "nasai/2437"],
    "016": ["bukhari/1395", "abudawud/1584", "ibnmajah/1783", "nasai/2522", "nasai/2435"],
}


def spec_of(addr: str) -> dict:
    kind, _, _rest = addr.partition("/")
    if kind.isdigit():
        s, a = addr.split("/")
        return {"kind": "quran", "surah": s, "ayah": a, "label": f"QS. {s}:{a}"}
    coll, no = addr.split("/")
    return {"kind": "hadith", "collection": coll, "hadithNo": no,
            "label": f"HR. {coll.title()} no. {no}"}


def main() -> None:
    out = {}
    for rid, q in QUESTIONS.items():
        vec = harness.embed([q])[0]
        rows = []
        for addr in SIBLINGS[rid]:
            spec = spec_of(addr)
            try:
                res = harness.rank_of(vec, spec, k=1)
            except SystemExit:
                rows.append({"addr": spec["label"], "missing": True})
                continue
            rows.append({"addr": spec["label"], "rank": res["rank"],
                         "cosine": round(res["cosine"], 4),
                         "top10": res["rank"] <= 10, "top50": res["rank"] <= 50})
        out[rid] = rows
        print(f"\n== {rid} verbatim: {q}")
        for r in rows:
            if r.get("missing"):
                print(f"  {r['addr']}: MISSING")
            else:
                mark = "  <-- top-10" if r["top10"] else ""
                print(f"  {r['addr']}: rank {r['rank']} (cos {r['cosine']}){mark}")
    Path(__file__).with_name("e3-results.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
