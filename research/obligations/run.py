#!/usr/bin/env python3
"""Experiment driver for the obligations-plan prototype.

  python3 research/obligations/run.py e1      # planner over the six questions
  python3 research/obligations/run.py e2      # fan-out reproduction, no generation
  python3 research/obligations/run.py e3      # the main B / B2 / P measurement
  python3 research/obligations/run.py e4      # admission-cap sensitivity (K=5)
  python3 research/obligations/run.py analyze # tables from the saved results

Every experiment appends a ledger line per paid call, so `analyze` reports the
spend by stage and by experiment. Each stage's JSON is written beside this file
and can be re-read without re-spending.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import arms
import kq
import plan as planner
import questions

HERE = Path(__file__).resolve().parent
DRAWS = 3


def _write(name: str, payload: object) -> None:
    (HERE / name).write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n")


def _read(name: str) -> object:
    path = HERE / name
    return json.loads(path.read_text()) if path.exists() else None


def required_state(groups: list[list[str]], labels: list[str], cited: list[str],
                   language: str) -> dict:
    known, cited_set = set(labels), set(cited)
    detail = []
    for group in groups:
        detail.append({
            "group": group,
            "in_context": [label for label in group if label in known],
            "cited": [label for label in group if label in cited_set],
        })
    return {
        "in_context": all(item["in_context"] for item in detail),
        "cited": all(item["cited"] for item in detail),
        "detail": detail,
    }


def answer_metrics(draw: dict, chunks: list[dict], question: dict) -> dict:
    labels = [kq.normalize_label(chunk.get("label") or "") for chunk in chunks]
    labels = [label for label in labels if label]
    cited = kq.citations_in(draw["text"])
    reading = kq.grounding(cited, labels)
    return {
        "text": draw["text"],
        "prompt_tokens": draw["prompt_tokens"],
        "completion_tokens": draw["completion_tokens"],
        "usd": draw["usd"],
        "reread": draw["reread"],
        "refusal": arms._is_pure_refusal(draw["text"], question["language"]),
        "citations": cited,
        "grounding": reading,
        "required": required_state(question["required_groups"], labels, cited,
                                   question["language"]),
    }


# ------------------------------------------------------------------------ E1


def e1() -> None:
    out = []
    for question in questions.QUESTIONS:
        started = time.time()
        planned = planner.plan(question["question"])
        print(f"\n{question['id']}: {question['question']}")
        print(f"  repair={planned['repair']}  planner_usd={planned['cost']['usd']:.6f}")
        for obligation in planned["obligations"]:
            print(f"  {obligation['id']} [{obligation['kind']}] {obligation['text']}")
        out.append({
            "question_id": question["id"],
            "question": question["question"],
            "obligations": planned["obligations"],
            "repair": planned["repair"],
            "raw": planned["raw"],
            "cost": planned["cost"],
            "seconds": round(time.time() - started, 1),
        })
    _write("e1-plans.json", out)
    print(f"\nspend: {json.dumps(kq.spend_summary(), sort_keys=True)}")


# ------------------------------------------------------------------------ E2


def e2() -> None:
    plans = {row["question_id"]: row for row in (_read("e1-plans.json") or [])}
    out = []
    for question in questions.QUESTIONS:
        started = time.time()
        reading = arms.route(question["question"])
        sub_queries = arms.decompose(question["question"], reading)
        baseline = arms.baseline_context(question["question"], sub_queries, reading["intent"])
        variant_subs = arms.caller_words_variant(question["question"], sub_queries)
        variant = arms.baseline_context(question["question"], variant_subs, reading["intent"])
        row = {
            "question_id": question["id"],
            "question": question["question"],
            "route": {key: reading[key] for key in
                      ("intent", "category", "needsPrinciple", "confidence", "fallback")},
            "sub_queries": sub_queries,
            "variant_sub_queries": variant_subs,
            "baseline": _context_summary(baseline, question),
            "variant": _context_summary(variant, question),
            "context_chars": {"baseline": len(baseline["context"]),
                              "variant": len(variant["context"])},
            "seconds": round(time.time() - started, 1),
        }
        out.append(row)
        print(f"{question['id']}: intent={reading['intent']} "
              f"subs={len(sub_queries)} fused={baseline['unique']} "
              f"required_in_B={row['baseline']['required']['in_context']} "
              f"required_in_B2={row['variant']['required']['in_context']}")
    _write("e2-baseline.json", out)
    print(f"spend: {json.dumps(kq.spend_summary(), sort_keys=True)}")


def _context_summary(context: dict, question: dict) -> dict:
    labels = [kq.normalize_label(chunk.get("label") or "") for chunk in context["chunks"]]
    labels = [label for label in labels if label]
    return {
        "queries": context["queries"],
        "lists": context["lists"],
        "hits": context["hits"],
        "unique": context["unique"],
        "rerank_applied": context["rerank_applied"],
        "chunks": len(context["chunks"]),
        "labels": labels,
        "required": required_state(question["required_groups"], labels, [], question["language"]),
    }


# ------------------------------------------------------------------------ E3


def e3() -> None:
    plans = {row["question_id"]: row for row in (_read("e1-plans.json") or [])}
    existing = {row["question_id"] + ":" + row["arm"]: row
                for row in (_read("results-main.json") or [])}
    results = list(existing.values())
    for question in questions.QUESTIONS:
        reading = arms.route(question["question"])
        sub_queries = arms.decompose(question["question"], reading)
        variant_subs = arms.caller_words_variant(question["question"], sub_queries)
        plan_row = plans.get(question["id"])
        if plan_row is None:
            raise SystemExit("run e1 first")
        obligations = plan_row["obligations"]

        for arm, context in (
            ("B", arms.baseline_context(question["question"], sub_queries, reading["intent"])),
            ("B2", arms.baseline_context(question["question"], variant_subs, reading["intent"])),
            ("P", arms.plan_context(question["question"], question["language"])),
        ):
            key = f"{question['id']}:{arm}"
            if key in existing:
                continue
            started = time.time()
            draws = []
            for draw_index in range(DRAWS):
                if arm == "P":
                    draw = arms.generate_plan(question["question"], context["context"],
                                              obligations, question["language"])
                else:
                    draw = arms.generate(question["question"], context["context"],
                                         question["language"], stage=f"generator:{arm}")
                draws.append(answer_metrics(draw, context["chunks"], question))
            judged = planner.judge(
                question["question"], obligations, context["chunks"],
                draws[0]["text"], question["language"],
            )
            record = {
                "question_id": question["id"],
                "question": question["question"],
                "kind": question["kind"],
                "arm": arm,
                "route": {field: reading[field] for field in
                          ("intent", "category", "needsPrinciple", "confidence", "fallback")},
                "sub_queries": variant_subs if arm == "B2" else sub_queries,
                "obligations": obligations,
                "plan_repair": plan_row["repair"],
                "retrieval": {field: context.get(field) for field in
                              ("queries", "lists", "hits", "unique", "rerank_applied")},
                "chunks": [
                    {"id": chunk["id"], "label": chunk.get("label"),
                     "source_type": chunk.get("source_type"),
                     "grade": chunk.get("grade"), "prob": chunk.get("prob"),
                     "serves": chunk.get("serves")}
                    for chunk in context["chunks"]
                ],
                "context_chars": len(context["context"]),
                "context_labels": context["context_labels"],
                "required_context": required_state(
                    question["required_groups"], context["context_labels"], [],
                    question["language"]),
                "answers": draws,
                "judge": {"readings": judged["readings"], "repair": judged["repair"],
                          "cost": judged["cost"]},
                "seconds": round(time.time() - started, 1),
            }
            results.append(record)
            existing[key] = record
            _write("results-main.json", results)
            required = sum(1 for draw in draws if draw["required"]["cited"])
            supported = sum(1 for reading in judged["readings"] if reading["supported"])
            print(f"{question['id']} {arm}: required_in_context="
                  f"{record['required_context']['in_context']} "
                  f"required_cited_draws={required}/{DRAWS} "
                  f"obligations_supported={supported}/{len(obligations)} "
                  f"context_chars={len(context['context'])} "
                  f"seconds={record['seconds']}")
    print(f"spend: {json.dumps(kq.spend_summary(), sort_keys=True)}")


# ------------------------------------------------------------------------ E4


def e4() -> None:
    plans = {row["question_id"]: row for row in (_read("e1-plans.json") or [])}
    out = []
    for question in questions.QUESTIONS:
        obligations = plans[question["id"]]["obligations"]
        context = arms.plan_context(question["question"], question["language"], admit_k=5)
        draw = arms.generate_plan(question["question"], context["context"], obligations,
                                  question["language"])
        metrics = answer_metrics(draw, context["chunks"], question)
        judged = planner.judge(question["question"], obligations, context["chunks"],
                               draw["text"], question["language"])
        out.append({
            "question_id": question["id"],
            "obligations": obligations,
            "admitted_total": context["admitted_total"],
            "context_chars": len(context["context"]),
            "required_context": required_state(
                question["required_groups"], context["context_labels"], [], question["language"]),
            "answer": metrics,
            "judge": judged["readings"],
        })
        supported = sum(1 for reading in judged["readings"] if reading["supported"])
        print(f"{question['id']} P(K=5): admitted={context['admitted_total']} "
              f"required_in_context={out[-1]['required_context']['in_context']} "
              f"required_cited={metrics['required']['cited']} "
              f"supported={supported}/{len(obligations)}")
    _write("results-sens.json", out)
    print(f"spend: {json.dumps(kq.spend_summary(), sort_keys=True)}")


# ------------------------------------------------------------------- analysis


def analyze() -> None:
    main = _read("results-main.json") or []
    e2_rows = _read("e2-baseline.json") or []
    e1_rows = _read("e1-plans.json") or []
    sens = _read("results-sens.json") or []

    print("== E1 plans")
    for row in e1_rows:
        kinds = ",".join(obligation["kind"] for obligation in row["obligations"])
        print(f"  {row['question_id']}: {len(row['obligations'])} obligations [{kinds}] "
              f"repair={row['repair']}")

    print("\n== E2 fan-out reproduction (retrieval only)")
    for row in e2_rows:
        print(f"  {row['question_id']}: intent={row['route']['intent']} "
              f"B required={row['baseline']['required']['in_context']} "
              f"B2 required={row['variant']['required']['in_context']} "
              f"B chunks={row['baseline']['chunks']} B2 chunks={row['variant']['chunks']} "
              f"B chars={row['context_chars']['baseline']}")

    print("\n== E3 main")
    header = ("question", "arm", "req_ctx", "req_cited", "ground", "cites",
              "prompt", "completion", "usd", "oblig_sat")
    print(" | ".join(header))
    for question in questions.QUESTIONS:
        for arm in ("B", "B2", "P"):
            row = next((item for item in main
                        if item["question_id"] == question["id"] and item["arm"] == arm), None)
            if row is None:
                continue
            required_cited = sum(1 for draw in row["answers"] if draw["required"]["cited"])
            grounding = [draw["grounding"]["grounding_rate"] for draw in row["answers"]
                         if draw["grounding"]["grounding_rate"] is not None]
            cites = [draw["grounding"]["citations"] for draw in row["answers"]]
            prompt = sum(draw["prompt_tokens"] for draw in row["answers"]) / len(row["answers"])
            completion = sum(draw["completion_tokens"] for draw in row["answers"]) / len(row["answers"])
            usd = sum(draw["usd"] for draw in row["answers"]) / len(row["answers"])
            supported = sum(1 for reading in row["judge"]["readings"] if reading["supported"])
            print(" | ".join(str(value) for value in (
                question["id"], arm, row["required_context"]["in_context"],
                f"{required_cited}/{len(row['answers'])}",
                (f"{sum(grounding)/len(grounding):.2f}" if grounding else "—"),
                f"{min(cites)}-{max(cites)}", int(prompt), int(completion),
                f"{usd:.6f}", f"{supported}/{len(row['obligations'])}")))

    print("\n== E4 admission K=5")
    for row in sens:
        supported = sum(1 for reading in row["judge"] if reading["supported"])
        print(f"  {row['question_id']}: admitted={row['admitted_total']} "
              f"req_ctx={row['required_context']['in_context']} "
              f"req_cited={row['answer']['required']['cited']} "
              f"supported={supported}/{len(row['obligations'])} "
              f"chars={row['context_chars']}")

    print(f"\nspend: {json.dumps(kq.spend_summary(), sort_keys=True)}")


def main() -> None:
    kq.load_env()
    kq.assert_local_dsn()
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    command = sys.argv[1]
    {"e1": e1, "e2": e2, "e3": e3, "e4": e4, "analyze": analyze}[command]()


if __name__ == "__main__":
    main()
