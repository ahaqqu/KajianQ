#!/usr/bin/env python3
"""E6 — what the >=3-run stability figure has to measure, and what a false "stable" looks like.

Three measurements, all on the four rows:

  1. **Embedding determinism.** The same question text embedded three times; cosine between the
     three vectors and the rank each produces. If the vendor is deterministic here, a local
     repeat cannot vary — which is exactly why a local repeat is not the stability evidence #647
     asks for.
  2. **Near-tie margins.** For each row's verbatim query, the cosine gap between the required row
     and its predecessor/successor, and how many rows sit within 0.002 of it. A "rank 8" with a
     0.0002 margin is a coin, not a position; the protocol must report the band, not the integer.
  3. **Reproduction of the four reported baselines.** The numbers #647 inherited, against this
     harness's measurement, so the brief can say which of them a deployed run may compare to.

Read-only. Writes research/647/e6-results.json.

Usage: set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e6-stability.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402

HERE = Path(__file__).parent
QUESTIONS = {
    "007": "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?",
    "008": "Hadits apa yang menyebutkan keutamaan membaca Al-Quran?",
    "011": "Sebutkan hadits tentang kebersihan itu sebagian dari iman!",
    "016": "Which hadith describes the obligations of Zakat, and what does it say?",
}
REPORTED = {"007": 5352, "008": 397, "011": 11, "016": 48}


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b)) / (
        (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5))


def top_rows(v: list[float], k: int = 60) -> list[tuple[str, float]]:
    lit = harness.vec_literal(v)
    rows = harness.psql(
        "select citation::text, 1 - (embedding_primary <=> " + lit + ") from doc_children "
        "where embedding_primary is not null order by embedding_primary <=> " + lit +
        f" limit {k};")
    out = []
    for c, cos in rows:
        cj = json.loads(c)
        out.append((harness.addr(cj), float(cos)))
    return out


def main() -> None:
    out: dict = {"determinism": {}, "margins": {}, "baselines": {}}

    # 1. determinism: three embeddings of the same text
    print("== embedding determinism (same text, three calls) ==")
    for rid in ["007", "011"]:
        reps = harness.embed([QUESTIONS[rid]] * 3)
        sims = [round(cosine(reps[0], reps[1]), 6), round(cosine(reps[0], reps[2]), 6),
                round(cosine(reps[1], reps[2]), 6)]
        ranks = [harness.rank_of(v, harness.TARGETS[rid], k=1)["rank"] for v in reps]
        out["determinism"][rid] = {"pairwiseCosine": sims, "ranks": ranks}
        print(f"  {rid}: pairwise cos {sims} ranks {ranks} -> "
              f"{'identical' if len(set(ranks)) == 1 and max(sims) == 1.0 else 'VARIES'}")

    # 2. near-tie margins under the verbatim question
    print("\n== near-tie margins (verbatim query) ==")
    for rid, q in QUESTIONS.items():
        vec = harness.embed([q])[0]
        target = harness.TARGETS[rid]["label"]
        rows = top_rows(vec, k=60)
        pos = next((i for i, (a, _) in enumerate(rows) if a == target), None)
        if pos is None:
            rank = harness.rank_of(vec, harness.TARGETS[rid], k=1)
            res = {"rank": rank["rank"], "inTop60": False}
            out["margins"][rid] = res
            print(f"  {rid} {target}: rank {rank['rank']} (outside top-60; no local margin)")
            continue
        cos = rows[pos][1]
        prev = rows[pos - 1][1] if pos > 0 else None
        nxt = rows[pos + 1][1] if pos + 1 < len(rows) else None
        near = sum(1 for _, c in rows if abs(c - cos) <= 0.002)
        res = {"rank": pos + 1, "cosine": round(cos, 6),
               "gapAbove": None if prev is None else round(prev - cos, 6),
               "gapBelow": None if nxt is None else round(cos - nxt, 6),
               "rowsWithin0002": near,
               "neighbours": [rows[i][0] for i in range(max(0, pos - 2), min(len(rows), pos + 3))]}
        out["margins"][rid] = res
        print(f"  {rid} {target}: rank {pos + 1}, cos {cos:.6f}, gap above {res['gapAbove']}, "
              f"below {res['gapBelow']}, rows within 0.002: {near}")
        print(f"      neighbours: {', '.join(res['neighbours'])}")

    # 3. baseline reproduction
    print("\n== reported baseline vs measured ==")
    for rid, expected in REPORTED.items():
        res = harness.rank_of(harness.embed([QUESTIONS[rid]])[0], harness.TARGETS[rid], k=1)
        out["baselines"][rid] = {"reported": expected, "measured": res["rank"],
                                 "delta": res["rank"] - expected}
        print(f"  {rid}: reported {expected}, measured {res['rank']}, delta {res['rank'] - expected:+d}")

    (HERE / "e6-results.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
