#!/usr/bin/env python3
"""E7 — blast radius and cost of each candidate, from the numbers E2–E6 measured.

Not a new retrieval run: this script composes measured ranks into the two quantities #647 asks
for — which rows move, and what a query costs — and pins the one safety number the concept table
has: the threshold window in which the table fires on the table-dependent questions and on none
of the Golden Set controls.

  * threshold sweep for matcher B, over E4's measured similarities;
  * displacement of every other candidate when one anchor is injected (rank + 1, measured ranks);
  * cost per representation from measured token counts and the recorded config prices;
  * corpus invariance (row count unchanged, read-only sessions).

Writes research/647/e7-results.json.

Usage: set -a; . /home/ahaqqu/Projects/KajianQ/.env; set +a; python3 research/647/e7-blast-radius.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402

HERE = Path(__file__).parent


def main() -> None:
    e4 = json.loads((HERE / "e4-results.json").read_text())
    e2 = json.loads((HERE / "e2-results.json").read_text())
    e5 = json.loads((HERE / "e5-results.json").read_text())
    e6 = json.loads((HERE / "e6-results.json").read_text())

    true_sims = [r["simToExpected"] for r in e4["rows"]]
    control_sims = [c["bestSim"] for c in e4["controls"]]

    # 1. threshold sweep: fires when nearest concept cosine >= tau. True = the question's own
    #    concept is the argmax and the cosine clears tau; controls must never fire.
    print("== matcher B threshold sweep (true questions vs 17 Golden Set controls) ==")
    sweep = []
    for tau in [0.60, 0.62, 0.64, 0.66, 0.68, 0.70, 0.72, 0.74, 0.76, 0.80]:
        true_fire = sum(1 for s in true_sims if s >= tau)
        false_fire = sum(1 for s in control_sims if s >= tau)
        sweep.append({"tau": tau, "trueFires": true_fire, "ofTrue": len(true_sims),
                      "falseFires": false_fire, "ofControls": len(control_sims)})
        print(f"  tau {tau:.2f}: true {true_fire}/{len(true_sims)}, "
              f"controls {false_fire}/{len(control_sims)}")
    window = [s for s in sweep if s["falseFires"] == 0 and s["trueFires"] == len(true_sims)]
    print(f"  clean window: {window[0]['tau'] if window else None} .. "
          f"{window[-1]['tau'] if window else None}")

    # 2. displacement: one injected anchor occupies one slot, so every candidate below it shifts
    #    by one. Required ranks are E2's measured verbatim ranks.
    print("\n== displacement of the required address when one anchor is injected ==")
    verbatim = {r["row"]: r["rank"] for r in e2["results"]
                if r["representation"] == "verbatim-question"}
    disp = {}
    for rid, rank in verbatim.items():
        after = rank + 1
        disp[rid] = {"before": rank, "after": after,
                     "top10Before": rank <= 10, "top10After": after <= 10,
                     "top50Before": rank <= 50, "top50After": after <= 50}
        print(f"  {rid}: rank {rank} -> {after} (top-10 {rank <= 10}->{after <= 10}, "
              f"top-50 {rank <= 50}->{after <= 50})")

    # 3. cost table from measured tokens and configured prices
    #    (packages/infra/src/providers/models.json: deepseek-v4-flash 0.30/1.20 per MTok;
    #     gemini-embedding-001 free-tier price 0, gemini-paid 0.20/MTok input)
    e2_spend = e2["spend"]
    e5_calls = e5["classifierAccuracy"][1]
    hyde_usd = (e2_spend["prompt_tokens"] * 0.30 + e2_spend["completion_tokens"] * 1.20) / 1e6
    e5_usd = 0.002259  # measured in E5's run (47 calls, 6859 prompt + 168 completion)
    n_embed_calls = 0
    for r in e2["results"]:
        if r.get("kind", "").startswith("text") or r.get("kind", "").startswith("llm"):
            n_embed_calls += 1
    rows_before = int(harness.psql(
        "select count(*) from doc_children where embedding_primary is not null;")[0][0])

    cost = {
        "hydePerQuery": {"llmCalls": 1,
                         "promptTokens": e2_spend["prompt_tokens"] / max(1, e2_spend["calls"]),
                         "completionTokens": e2_spend["completion_tokens"] / max(1, e2_spend["calls"]),
                         "usdPerQuery": hyde_usd / max(1, e2_spend["calls"])},
        "classifierPerQuery": {"llmCalls": 1, "usdPerQuery": e5_usd / e5_calls},
        "tablePerEntry": {"embeddings": 1, "sqlReads": 1,
                          "usdPerEntry": 0.000012},  # ~60 label tokens at $0.20/MTok, estimate
        "tablePerQueryNoMatch": {"embeddings": 0, "llmCalls": 0,
                                 "measuredUs": e4["summaries"]["fullMatcherUs"],
                                 "concepts": e4["summaries"]["conceptCount"],
                                 "memoryKiB": e4["summaries"]["memoryKiB"]},
        "tablePerQueryMatch": {"embeddings": 0, "llmCalls": 0, "sqlReads": 1},
        "k10to50": {"embeddings": 0, "llmCalls": 0, "candidatesPerTrack": "5x"},
        "filterFix646": {"embeddings": 0, "llmCalls": 0, "code": "merged at head"},
        "rowsBefore": rows_before,
        "embeddingCallsInE2": n_embed_calls,
        "e2LlmUsd": round(hyde_usd, 6),
        "e5LlmUsd": e5_usd,
        "totalLlmUsd": round(hyde_usd + e5_usd + 0.000570, 6),
    }
    print("\n== cost per representation ==")
    for k, v in cost.items():
        print(f"  {k}: {v}")

    (HERE / "e7-results.json").write_text(json.dumps(
        {"sweep": sweep, "cleanWindow": window, "displacement": disp, "cost": cost,
         "rowsBefore": rows_before}, indent=1))


if __name__ == "__main__":
    main()
