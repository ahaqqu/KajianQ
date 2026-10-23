#!/usr/bin/env python3
"""E4 — the concept->anchor table: content, matcher, coverage, cost, falsifiers.

Measures, on a proposed held-out aqidah set plus 007 and the other Golden Set questions:

  1. the anchor the table names exists in the corpus (one read each, $0);
  2. the verbatim question's dense rank for that anchor (does the table even need to exist for
     this item?);
  3. the lexical overlap between question and anchor, which is the stated falsifier ("an anchor
     that only works because the question quotes the verse");
  4. matcher A — a trigger lexicon, deterministic, $0 per query;
  5. matcher B — cosine between the question and the concept label, reusing the query vector the
     retriever already computed (threshold swept over the measured similarities);
  6. the same two matchers on two LLM-written paraphrases of each question, which the lexicon
     was not written for — the held-out check;
  7. the per-query cost when no anchor matches, measured in-process, and the table size the set
     implies.

Writes research/647/e4-results.json. Read-only against the corpus.

Usage: set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e4-concept-anchor.py
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402
from llm import llm, spend_line  # noqa: E402

HERE = Path(__file__).parent
HELDOUT = json.loads((HERE / "heldout-aqidah-v0.json").read_text())
GOLDEN = json.loads((HERE.parents[1] / "packages/kajianq-domain/fixtures/golden-set-v0.json").read_text())
Q007 = "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?"

TABLE007 = {
    "concept": "tanzih-mukhalafat",
    "doctrine": "Allah is not like anything created",
    "question": Q007,
    "anchor": "QS. 42:11",
    "conceptLabel": ("Sifat wajib bagi Allah: tanzih, mukhalafat lil hawadits, "
                     "Allah tidak menyerupai makhluk-Nya"),
    "triggers": ["sifat wajib", "tanzih", "mukhalafat", "menyerupai allah", "menyerupai makhluk"],
}

PARAPHRASE_PROMPT = (
    "Tulis dua parafrase berbeda dari pertanyaan berikut, dalam bahasa Indonesia, masing-masing "
    "satu baris. Jangan menambah jawaban, jangan mengutip ayat atau hadis, jangan menyebut nomor. "
    "Pertanyaan: {q}\nFormat: baris 1 = parafrase pertama; baris 2 = parafrase kedua."
)


def norm(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def overlap(question: str, anchor_text: str) -> dict:
    """Content-word overlap and the longest shared token run — the quote falsifier."""
    q, a = norm(question).split(), norm(anchor_text).split()
    stop = {"yang", "dan", "itu", "apa", "apakah", "bagaimana", "dalam", "dari", "kepada",
            "oleh", "untuk", "pada", "adalah", "tidak", "ada", "bisa", "dapat", "mengapa",
            "sifat", "allah", "allahu", "shallallahu", "alaihi", "wasallam", "rasulullah",
            "kami", "dia", "dengan", "akan", "ini", "ia", "para", "semua", "segala"}
    qc = [w for w in q if w not in stop and len(w) > 2]
    ac = set(w for w in a if w not in stop and len(w) > 2)
    shared = [w for w in qc if w in ac]
    # longest run of consecutive question tokens also present in the anchor
    aset = set(a)
    best = run = 0
    for w in q:
        run = run + 1 if w in aset else 0
        best = max(best, run)
    return {"sharedContentWords": shared, "longestSharedTokenRun": best,
            "jaccard": round(len(set(qc) & ac) / len(set(qc) | ac), 3) if qc else 0.0}


def trigger_hits(question: str, entry: dict) -> list[str]:
    q = norm(question)
    return [t for t in entry["triggers"] if norm(t) and norm(t) in q]


def main() -> None:
    entries = [TABLE007] + HELDOUT["entries"]
    control_questions = [q for q in GOLDEN["questions"] if q["id"] != "gs-v0-007"]

    # 1. anchor existence + 2. verbatim dense rank + 3. overlap falsifier
    print("== existence, verbatim rank, quote falsifier ==")
    items = []
    for e in entries:
        spec = spec_of_addr(e["anchor"])
        row = harness.target_row(spec)  # exits if not exactly one row
        res = harness.rank_of(harness.embed([e["question"]])[0], spec, k=1)
        ov = overlap(e["question"], row["text_id"])
        items.append({**e, "anchorExists": True, "verbatimRank": res["rank"],
                      "anchorText": row["text_id"][:220], "overlap": ov})
        print(f"  {e['concept']:<20} {e['anchor']:<12} verbatim rank {res['rank']:>6} "
              f"shared={ov['sharedContentWords'][:4]} run={ov['longestSharedTokenRun']} "
              f"jaccard={ov['jaccard']}")

    # 4/5. matchers over: each entry's question, 007, controls, and LLM paraphrases
    print("\n== matcher A (trigger lexicon) and matcher B (label cosine) ==")
    concept_vecs = {e["concept"]: harness.embed([e["conceptLabel"]])[0] for e in entries}
    paraphrase_cache: dict[str, list[str]] = {}
    rows = []
    for e in entries:
        variants = [("original", e["question"])]
        para = llm(PARAPHRASE_PROMPT.format(q=e["question"]))
        paraphrases = [ln.strip(" -•\t") for ln in para.splitlines() if ln.strip()][:2]
        paraphrase_cache[e["concept"]] = paraphrases
        for i, p in enumerate(paraphrases):
            variants.append((f"paraphrase-{i + 1}", p))
        for kind, text in variants:
            vec = harness.embed([text])[0]
            sims = {c: cosine(vec, v) for c, v in concept_vecs.items()}
            best = max(sims, key=sims.get)
            hits = {c: trigger_hits(text, en) for c, en in
                    [(x["concept"], x) for x in entries]}
            fired = [c for c, h in hits.items() if h]
            rows.append({"item": e["concept"], "variant": kind, "text": text,
                         "expected": e["concept"],
                         "triggerFired": fired,
                         "bestConcept": best, "bestSim": round(sims[best], 4),
                         "simToExpected": round(sims[e["concept"]], 4),
                         "top3": sorted(((c, round(s, 4)) for c, s in sims.items()),
                                        key=lambda x: -x[1])[:3]})
            print(f"  {e['concept']:<20} {kind:<14} triggers={str(fired):<28} "
                  f"bestCos={best}/{sims[best]:.3f} expected={sims[e['concept']]:.3f}")
    # controls: must not fire and must not score above the true items
    control_rows = []
    for q in control_questions:
        vec = harness.embed([q["question"]])[0]
        sims = {c: cosine(vec, v) for c, v in concept_vecs.items()}
        best = max(sims, key=sims.get)
        fired = [c for c in concept_vecs if trigger_hits(q["question"], next(x for x in entries if x["concept"] == c))]
        control_rows.append({"id": q["id"], "triggerFired": fired, "bestConcept": best,
                             "bestSim": round(sims[best], 4), "text": q["question"]})
        print(f"  control {q['id']}: triggers={fired if fired else '[]'} bestCos={best}/{sims[best]:.3f}")

    # 6. separation summary
    true_sims = [r["simToExpected"] for r in rows]
    false_sims = [r["bestSim"] for r in control_rows]
    print(f"\n  true-item similarity: min {min(true_sims):.3f} max {max(true_sims):.3f}")
    print(f"  control best-similarity: min {min(false_sims):.3f} max {max(false_sims):.3f}")

    # 7. per-query cost when nothing matches (pure computation, measured in-process)
    c_count = len(entries)
    reps = 5000
    t0 = time.perf_counter()
    acc = 0.0
    for _ in range(reps):
        for v in concept_vecs.values():
            acc += cosine(concept_vecs["tanzih-mukhalafat"], v)
    full_us = (time.perf_counter() - t0) / reps * 1e6
    print(f"\n  no-match path: {c_count} concept vectors, {c_count * 1536 * 4 / 1024:.0f} KiB, "
          f"{full_us:.1f} us per query for {c_count} full 1536-dim cosines (acc {acc:.1f})")

    out = {"items": items, "rows": rows, "controls": control_rows,
           "summaries": {"trueMin": min(true_sims), "trueMax": max(true_sims),
                         "controlMin": min(false_sims), "controlMax": max(false_sims),
                         "fullMatcherUs": full_us,
                         "conceptCount": c_count,
                         "memoryKiB": c_count * 1536 * 4 / 1024},
           "paraphrases": paraphrase_cache}
    (HERE / "e4-results.json").write_text(json.dumps(out, indent=1))
    print("\n" + spend_line())


def cosine(a: list[float], b: list[float]) -> float:
    num = sum(x * y for x, y in zip(a, b))
    da = sum(x * x for x in a) ** 0.5
    db = sum(y * y for y in b) ** 0.5
    return num / (da * db) if da and db else 0.0


def spec_of_addr(addr: str) -> dict:
    kind, _, rest = addr.partition(".")
    if kind == "QS":
        s, a = rest.strip().split(":")
        return {"kind": "quran", "surah": s, "ayah": a, "label": addr}
    return {"kind": "hadith", "collection": "?", "hadithNo": "?", "label": addr}


if __name__ == "__main__":
    main()
