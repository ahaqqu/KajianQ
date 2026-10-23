#!/usr/bin/env python3
"""E0 — prove the harness before its numbers count.

Every check below is a case whose answer is known independently of this
prototype: a corpus count, a rank a prior researcher measured, a production
stage's output dumped from its own code, a hand-computed RRF score, or a
synthetic answer whose grounded and fabricated citations are known by
construction. The script exits non-zero when any check fails, so a run that
proceeds past it is a run whose instruments have been validated.

Usage:
  set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a
  python3 research/obligations/selfcheck.py
"""

from __future__ import annotations

import json
import sys

import kq
import plan as planner
import arms

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}: {detail}")
    if not ok:
        FAILURES.append(name)


def exact_rank(vector: list[float], where: str) -> int:
    literal = kq.vec_literal(vector)
    rows = kq.psql_json(
        "select coalesce(json_agg(row_to_json(t)), '[]')::text from ("
        f" select count(*) + 1 as rank from doc_children c"
        f" where c.embedding_primary is not null"
        f" and (c.embedding_primary <=> {literal}) <"
        f" (select b.embedding_primary <=> {literal} from doc_children b"
        f"    where b.embedding_primary is not null and {where} limit 1)) t;"
    )
    return int(rows[0]["rank"])


def position(chunks: list[dict], label: str) -> int | None:
    wanted = kq.normalize_label(label)
    for index, chunk in enumerate(chunks, start=1):
        if kq.normalize_label(chunk.get("label") or "") == wanted:
            return index
    return None


def main() -> None:
    kq.load_env()
    kq.assert_local_dsn()

    # S1 — corpus shape.
    stats = kq.corpus_stats()
    check("S1 corpus rows", stats["total"] == 42511,
          f"total={stats['total']} primary={stats['primary']} fallback={stats['fallback']}")
    check("S1 embedding coverage", stats["primary"] == 42511,
          "every row carries embedding_primary")

    # S2 — the embedding space matches the prior researcher's exact ranks.
    question_007 = "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?"
    vector = kq.embed([question_007])[0]
    rank_007 = exact_rank(vector, "b.citation->>'surah'='42' and b.citation->>'ayah'='11'")
    check("S2 QS. 42:11 exact rank reproduces #647's 5352",
          abs(rank_007 - 5352) <= 2,
          f"measured {rank_007}, reported 5352 (delta {rank_007 - 5352:+d})")

    # S3 — gs-v0-011's verbatim question puts the required hadith at primary
    # dense rank 8, the exact rank #647 measured.
    question_011 = "Sebutkan hadits tentang kebersihan itu sebagian dari iman!"
    hits_011 = kq.search(kq.embed([question_011])[0])
    primary_011 = [hit for hit in hits_011 if hit["track"] == "primary"]
    rank_011 = next((i for i, hit in enumerate(primary_011, start=1)
                     if kq.normalize_label(hit["citation"]) == "hr. muslim no. 534"), None)
    check("S3 gs-v0-011 verbatim question puts Muslim 534 at primary rank 8",
          rank_011 == 8,
          f"primary dense rank {rank_011} (reported exact rank 8)")

    # S4 — the known miss: gs-v0-007's required verse sits at exact rank 5352,
    # so no top-ten fan-out can reach it. A harness that finds it here is wrong.
    question_007_reading = arms.route(question_007)
    subs_007 = arms.decompose(question_007, question_007_reading)
    baseline_007 = arms.baseline_context(question_007, subs_007, question_007_reading["intent"])
    labels_007 = [kq.normalize_label(chunk.get("label") or "") for chunk in baseline_007["chunks"]]
    check("S4 gs-v0-007 baseline cannot reach QS. 42:11",
          "qs. 42:11" not in labels_007,
          f"{len(labels_007)} chunks assembled; required verse absent "
          f"(exact rank {rank_007})")

    # S5 — the displacement case: the verbatim question reaches Ibnu Majah 224
    # and the rerank puts it first. What the fan-out does with it is measured,
    # not asserted: locally the router's own paraphrase still reaches it.
    question_004 = "Apa yang Nabi Islam katakan tentang mencari ilmu?"
    verbatim_hits = kq.search(kq.embed([question_004])[0])
    primary_004 = [hit for hit in verbatim_hits if hit["track"] == "primary"]
    verbatim_rank = next((i for i, hit in enumerate(primary_004, start=1)
                          if kq.normalize_label(hit["citation"]) == "hr. ibnmajah no. 224"), None)
    check("S5 verbatim question puts Ibnu Majah 224 in the top three",
          verbatim_rank is not None and verbatim_rank <= 3,
          f"primary dense rank {verbatim_rank}")
    fused_004 = kq.fuse([verbatim_hits], "factual")
    reranked_004 = kq.rerank(question_004, fused_004)
    top_004 = position(reranked_004["chunks"], "HR. Ibn Majah no. 224")
    check("S5 rerank puts the verbatim question's hit first",
          top_004 == 1,
          f"Ibnu Majah 224 rerank position {top_004} of {len(reranked_004['chunks'])}, "
          f"applied={reranked_004['applied']}")

    # S6 — the production decomposition bridge, and the displacement it encodes.
    reading_004 = arms.route(question_004)
    subs_004 = arms.decompose(question_004, reading_004)
    normalized_004 = arms._normalize(question_004)
    check("S6 production decomposition drops the caller's words",
          all(arms._normalize(sub["text"]) != normalized_004 for sub in subs_004),
          f"{[sub['text'] for sub in subs_004]}")
    variant_004 = arms.caller_words_variant(question_004, subs_004)
    check("S6 caller-words variant restores the question",
          any(arms._normalize(sub["text"]) == normalized_004 for sub in variant_004),
          f"{len(variant_004)} sub-queries, first={variant_004[0]['text'][:40]!r}")

    # S7 — RRF arithmetic against a hand-computed case.
    hand = kq.fuse([
        [{"id": "a", "track": "primary", "text_ar": "A", "text_id": "a", "citation": "QS. 1:1",
          "grade": None, "source_type": "quran"}],
        [{"id": "a", "track": "fallback", "text_ar": "A", "text_id": "a", "citation": "QS. 1:1",
          "grade": None, "source_type": "quran"}],
    ], None)
    expected = (1 + 0.3) / (kq.RRF_K + 1) + (1 + 0.3) / (kq.RRF_K + 1)
    check("S7 RRF score matches the hand computation",
          abs(hand[0]["score"] - expected) < 1e-12,
          f"measured {hand[0]['score']:.12f}, expected {expected:.12f} (quran bonus 0.3)")

    # S8 — citation reading and grounding on a synthetic answer.
    answer = ("Dalilnya QS. 2:255 dan QS. 2:255—256, serta HR. Bukhari no. 1. "
              "Adapun HR. Bukhari no. 99999 tidak ada dalilnya.")
    cited = kq.citations_in(answer)
    context_labels = [kq.normalize_label("QS. 2:255"), kq.normalize_label("QS. 2:256"),
                      kq.normalize_label("HR. Bukhari no. 1")]
    reading = kq.grounding(cited, context_labels)
    check("S8 citation scan finds four distinct labels",
          cited == ["qs. 2:255", "qs. 2:255-256", "hr. bukhari no. 1", "hr. bukhari no. 99999"],
          f"{cited}")
    check("S8 a fabricated address is ungrounded, a covered range is grounded",
          reading["ungrounded"] == ["hr. bukhari no. 99999"]
          and reading["grounding_rate"] == 0.75,
          f"grounded={reading['grounded']} ungrounded={reading['ungrounded']} "
          f"rate={reading['grounding_rate']}")

    # S9 — the planner's deterministic repairs.
    cases = [
        ("fenced json", "```json\n{\"obligations\":[{\"kind\":\"comparison\",\"text\":\"a\"}]}\n```",
         ["a"], []),
        ("bare array", "[{\"kind\":\"definition\",\"text\":\"b\"}]", ["b"], ["salvaged:top-level-array"]),
        ("bad kind dropped", '{"obligations":[{"kind":"vibe","text":"x"},{"kind":"ruling","text":"y"}]}',
         ["y"], ["dropped:0:kind='vibe'"]),
        ("duplicate dropped", '{"obligations":[{"kind":"scope","text":"z"},{"kind":"ruling","text":"Z "}]}',
         ["z"], ["dropped:1:duplicate"]),
        ("over cap truncated", json.dumps({"obligations": [
            {"kind": "scope", "text": f"t{index}"} for index in range(7)]}),
         ["t0", "t1", "t2", "t3", "t4"], ["truncated:7->5"]),
        ("no list", "I cannot plan this.", ["the question"], ["fallback:no-list"]),
        ("empty list", '{"obligations":[]}', ["the question"], ["fallback:empty"]),
    ]
    all_ok = True
    for name, text, expected_texts, expected_repairs in cases:
        parsed = planner.parse_plan(text, "the question")
        texts = [obligation["text"] for obligation in parsed["obligations"]]
        if texts != expected_texts or parsed["repair"] != expected_repairs:
            all_ok = False
            print(f"  planner case {name!r}: got {texts} {parsed['repair']}, "
                  f"expected {expected_texts} {expected_repairs}")
    check("S9 planner repairs are deterministic and exact", all_ok,
          f"{len(cases)} cases: fenced, bare array, bad kind, duplicate, cap, no list, empty")

    # S10 — the validator reader defaults an unreadable obligation to unsupported.
    obligations = [{"id": "O1"}, {"id": "O2"}]
    read = planner.read_validator(
        '{"obligations":[{"id":"O1","supported":true,"evidence":["E1"],"answer_cites":"E1"}]}',
        obligations,
    )
    check("S10 validator reader defaults a missing obligation to unsupported",
          read["readings"][0]["supported"] is True
          and read["readings"][1]["supported"] is False
          and read["repair"] == ["missing:O2"],
          f"{read['readings']} repair={read['repair']}")

    # S11 — the evidence judge has a positive and a negative control.
    positive = planner.judge(
        "Which hadith describes the obligations of Zakat, and what does it say?",
        [{"id": "O1", "kind": "dalil", "text": "hadith stating the obligation of zakat"}],
        [{"evidence_id": "E1", "label": "HR. Bukhari no. 1395",
          "grade": None, "text_ar": "", "text_id":
          "Rasulullah mewajibkan zakat, dan beliau menyebutkan kewajiban zakat dari harta."}],
        None, "en",
    )
    negative = planner.judge(
        "Which hadith describes the obligations of Zakat, and what does it say?",
        [{"id": "O1", "kind": "dalil", "text": "hadith stating the obligation of zakat"}],
        [{"evidence_id": "E1", "label": "HR. Bukhari no. 1108",
          "grade": None, "text_ar": "", "text_id":
          "Nabi pernah menggabungkan shalat Maghrib dan Isya ketika safar."}],
        None, "en",
    )
    positive_ok = positive["readings"][0]["supported"] is True
    negative_ok = negative["readings"][0]["supported"] is False
    check("S11 evidence judge separates a gold passage from an unrelated one",
          positive_ok and negative_ok,
          f"positive={positive_ok} negative={negative_ok} "
          f"(reasons: {positive['readings'][0]['reason'][:60]!r} / "
          f"{negative['readings'][0]['reason'][:60]!r})")

    print()
    print(f"spend: {json.dumps(kq.spend_summary(), sort_keys=True)}")
    if FAILURES:
        print(f"SELFCHECK FAILED: {FAILURES}")
        sys.exit(1)
    print("SELFCHECK PASSED")


if __name__ == "__main__":
    main()
