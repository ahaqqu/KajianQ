#!/usr/bin/env python3
"""E5 — matcher C (an LLM concept classifier), two more table-dependent held-out items, and the
corpus support a curated table can lean on.

Three measurements:

  1. **Extra held-out items authored with scholastic vocabulary** (qiyamuhu binafsihi, baqa,
     qudrah) — the class the table exists for is the one the verbatim question does not reach, so
     each candidate is kept only if its anchor's verbatim rank is outside the top-50. Measured.
  2. **Matcher C** — one LLM call per question that returns a concept id from the table or `none`
     (`temperature: 0`, `reasoning_effort: none`). Accuracy on the held-out originals, the LLM
     paraphrases and the 17 Golden Set controls; cost from the vendor's usage block.
  3. **Corpus support for the 20 canonical *sifat wajib*** — how many of the twenty names appear
     literally in any Quran translation. A table entry whose concept has no lexical foothold in
     the corpus cannot be built by term lookup; that count is the curation argument.

Read-only against the corpus. Writes research/647/e5-results.json.

Usage: set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e5-matcher-c.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402
from llm import llm, spend_line  # noqa: E402

HERE = Path(__file__).parent
HELDOUT = json.loads((HERE / "heldout-aqidah-v0.json").read_text())
E4 = json.loads((HERE / "e4-results.json").read_text())
GOLDEN = json.loads((HERE.parents[1] / "packages/kajianq-domain/fixtures/golden-set-v0.json").read_text())

EXTRA = [
    {"concept": "qiyamuhu-binafsihi",
     "question": "Apa dalil sifat qiyamuhu binafsihi, yakni Allah berdiri sendiri tidak membutuhkan yang lain?",
     "anchor": "QS. 2:255"},
    {"concept": "baqa-kekal",
     "question": "Apa dalil bahwa Allah Mahakekal dan tidak akan binasa?",
     "anchor": "QS. 55:27"},
    {"concept": "qudrah-umum",
     "question": "Bagaimana dalil bahwa kekuasaan Allah tidak terbatas oleh apa pun?",
     "anchor": "QS. 2:20"},
    {"concept": "ilmu-hati",
     "question": "Apakah Allah mengetahui isi hati manusia yang tersembunyi?",
     "anchor": "QS. 57:6"},
]

# The twenty attributes classical Ahlus Sunnah teaching lists; the strings are the Indonesian
# names as they appear in teaching texts, not in the corpus's translations.
SIFAT_20 = ["wujud", "qidam", "baqa", "mukhalafat lil hawadits", "qiyamuhu binafsihi",
            "wahdaniyah", "qudrah", "iradah", "ilmu", "hayat", "sama", "bashar", "kalam",
            "kaunuhu qadiran", "muridan", "aliman", "hayyan", "sami an", "bashiran",
            "mutakalliman"]

CLASSIFY_PROMPT = (
    "Anda memetakan pertanyaan ke salah satu konsep aqidah berikut, atau ke 'none' bila tidak "
    "ada yang cocok. Konsep:\n{concepts}\n\nJawab HANYA dengan id konsep atau 'none', tanpa "
    "penjelasan.\nPertanyaan: {q}"
)


def spec_of_addr(addr: str) -> dict:
    kind, _, rest = addr.partition(".")
    if kind == "QS":
        s, a = rest.strip().split(":")
        return {"kind": "quran", "surah": s, "ayah": a, "label": addr}
    raise ValueError(addr)


def main() -> None:
    entries = E4["items"]
    ids = [e["concept"] for e in entries]

    # 1. extra held-out candidates: only table-dependent ones survive
    print("== extra held-out candidates (kept if verbatim rank > 50) ==")
    extra = []
    for e in EXTRA:
        spec = spec_of_addr(e["anchor"])
        row = harness.target_row(spec)
        res = harness.rank_of(harness.embed([e["question"]])[0], spec, k=1)
        kept = res["rank"] > 50
        extra.append({**e, "verbatimRank": res["rank"], "kept": kept,
                      "anchorText": row["text_id"][:160]})
        print(f"  {e['concept']:<22} {e['anchor']:<10} rank {res['rank']:>6} "
              f"{'KEPT' if kept else 'dropped (reachable)'}")

    # 2. matcher C: classify originals, paraphrases, controls
    concepts_block = "\n".join(f"- {i}" for i in ids)
    print("\n== matcher C: LLM classifier ==")
    cases = []
    for e in entries:
        cases.append({"item": e["concept"], "variant": "original", "text": e["question"],
                      "expected": e["concept"]})
        for i, p in enumerate(E4["paraphrases"].get(e["concept"], [])):
            cases.append({"item": e["concept"], "variant": f"paraphrase-{i + 1}", "text": p,
                          "expected": e["concept"]})
    for q in GOLDEN["questions"]:
        if q["id"] == "gs-v0-007":
            continue
        cases.append({"item": "control", "variant": q["id"], "text": q["question"],
                      "expected": "none"})
    correct = 0
    for c in cases:
        out = llm(CLASSIFY_PROMPT.format(concepts=concepts_block, q=c["text"]), max_tokens=400)
        answer = out.strip().strip('"').splitlines()[0].strip() if out else ""
        c["answer"] = answer
        c["ok"] = answer == c["expected"]
        correct += int(c["ok"])
    print(f"  accuracy {correct}/{len(cases)}")
    by_variant = {}
    for c in cases:
        key = c["variant"] if c["item"] == "control" else "held-out-" + c["variant"]
        a = by_variant.setdefault(key, [0, 0])
        a[0] += int(c["ok"])
        a[1] += 1
    for k, (ok, n) in sorted(by_variant.items()):
        print(f"    {k}: {ok}/{n}")

    # 3. corpus support for the twenty attributes
    print("\n== corpus support: literal occurrence of the 20 sifat names ==")
    support = []
    for name in SIFAT_20:
        n = int(harness.psql(
            "select count(*) from doc_children where citation->>'sourceType'='quran' "
            f"and lower(text_id) like '%{name.replace(chr(39), chr(39) * 2)}%';")[0][0])
        support.append({"name": name, "quranRows": n})
        print(f"  {name:<26} rows: {n}")
    found = sum(1 for s in support if s["quranRows"] > 0)
    print(f"  {found}/20 names occur literally in any Qur'an translation row")

    (HERE / "e5-results.json").write_text(json.dumps(
        {"extra": extra, "classifier": cases, "classifierAccuracy": [correct, len(cases)],
         "sifatSupport": support, "sifatLiteral": found}, indent=1))
    print("\n" + spend_line())


if __name__ == "__main__":
    main()
