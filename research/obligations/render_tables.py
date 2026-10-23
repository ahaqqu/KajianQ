#!/usr/bin/env python3
"""Render the measurement tables for docs/research/obligations.md.

Reads analysis.json, e1-plans.json and e2-baseline.json and writes the tables
into the report between `<!-- TABLE:<name> -->` markers. No paid call.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOC = HERE.parents[1] / "docs" / "research" / "obligations.md"
ANALYSIS = json.loads((HERE / "analysis.json").read_text())
PLANS = {row["question_id"]: row for row in json.loads((HERE / "e1-plans.json").read_text())}
E2 = {row["question_id"]: row for row in json.loads((HERE / "e2-baseline.json").read_text())}
IDENTITY = json.loads((HERE / "identity-classes.json").read_text())["classes"]

TABLES = ANALYSIS["tables"]
ORDER = ["q-owner", "q-tri", "gs-v0-022", "gs-v0-016", "gs-v0-006", "q-ruling"]


def rows() -> list[dict]:
    return sorted(TABLES, key=lambda row: (ORDER.index(row["question_id"]),
                                            ("B", "B2", "P").index(row["arm"])))


def yes(value: bool) -> str:
    return "yes" if value else "**no**"


def evidence_table() -> str:
    lines = ["| Question | Arm | Draws | Ctx chunks | Obligations supported | Required in context — exact / identity | Required cited — exact / identity | Citations per answer | Grounding | Refusals |",
             "|---|---|---:|---:|---|---|---|---|---|---|"]
    for row in rows():
        lines.append("| {} | {} | {} | {} | {}/{} | {} / {} | {}/{} / {}/{} | {} | {} | {} |".format(
            row["question_id"], row["arm"], row["draws"], row["context_chunks"],
            row["obligations_supported"], row["obligations"],
            yes(row["exact_context"]["in_context"]), yes(row["identity_context"]["in_context"]),
            row["exact_cited_draws"], row["draws"],
            row["identity_cited_draws"], row["draws"],
            f"{min(row['citations_per_draw'])}–{max(row['citations_per_draw'])}",
            "1.00" if row["grounding_rate_mean"] == 1 else f"{row['grounding_rate_mean']:.2f}",
            f"{row['refusals']}/{row['draws']}"))
    return "\n".join(lines)


def cost_table() -> str:
    lines = ["| Question | Arm | Prompt tok | Completion tok | Generation µUSD | Retrieval + plan µUSD | Validator µUSD | Total µUSD/answer |",
             "|---|---|---:|---:|---:|---:|---:|---:|"]
    for row in rows():
        cost = row["cost_usd"]
        retrieval = sum(cost[key] for key in ("router_usd", "embed_usd", "rerank_usd", "planner_usd"))
        lines.append("| {} | {} | {:,} | {:,} | {:,.0f} | {:,.0f} | {:,.0f} | **{:,.0f}** |".format(
            row["question_id"], row["arm"], round(row["prompt_tokens"]),
            round(row["completion_tokens"]), row["generation_usd_per_draw"] * 1e6,
            retrieval * 1e6, cost["validator_usd"] * 1e6, row["per_answer_micro_usd"]))
    return "\n".join(lines)


def aggregate_table() -> str:
    lines = ["| Arm | Questions | Draws | Obligations supported | Required in context (exact / identity) | At least one draw cites the required address (exact / identity) | Refusals | Ungrounded citations | Prompt tok / answer | Completion tok / answer | µUSD / answer |",
             "|---|---:|---:|---|---|---|---:|---:|---:|---:|---:|"]
    for arm in ("B", "B2", "P"):
        subset = [row for row in rows() if row["arm"] == arm]
        n = len(subset)
        obligations = sum(row["obligations"] for row in subset)
        supported = sum(row["obligations_supported"] for row in subset)
        exact_ctx = sum(1 for row in subset if row["exact_context"]["in_context"])
        ident_ctx = sum(1 for row in subset if row["identity_context"]["in_context"])
        exact_cited = sum(1 for row in subset if row["exact_cited_draws"])
        ident_cited = sum(1 for row in subset if row["identity_cited_draws"])
        refusals = sum(row["refusals"] for row in subset)
        draws = sum(row["draws"] for row in subset)
        ungrounded = sum(len(row["ungrounded_citations"]) for row in subset)
        prompt = sum(row["prompt_tokens"] for row in subset) / n
        completion = sum(row["completion_tokens"] for row in subset) / n
        cost = sum(row["per_answer_micro_usd"] for row in subset) / n
        lines.append("| {} | {} | {} | {}/{} | {}/{} / {}/{} | {}/{} / {}/{} | {}/{} | {} | {:,} | {:,} | **{:,}** |".format(
            arm, n, draws, supported, obligations,
            exact_ctx, n, ident_ctx, n, exact_cited, n, ident_cited, n,
            refusals, draws, ungrounded, round(prompt), round(completion), round(cost)))
    return "\n".join(lines)


def plan_table() -> str:
    lines = ["| Question | Obligations (kind: text) | Repair | Planner µUSD |",
             "|---|---|---|---:|"]
    for question_id in ORDER:
        row = PLANS[question_id]
        obligations = "<br>".join(f"`{item['id']}` {item['kind']}: {item['text']}"
                                  for item in row["obligations"])
        repair = "none" if not row["repair"] else "; ".join(str(item) for item in row["repair"])
        lines.append(f"| {question_id} | {obligations} | {repair} | {row['cost']['usd'] * 1e6:,.0f} |")
    return "\n".join(lines)


def baseline_table() -> str:
    lines = ["| Question | B: required address in context | B2: required address in context | Fan-out sub-queries (B) |",
             "|---|---|---|---|"]
    for question_id in ORDER:
        row = E2[question_id]
        base = row["baseline"]["required"]
        variant = row["variant"]["required"]
        queries = "<br>".join(f"`{query}`" for query in row["baseline"]["queries"])
        lines.append("| {} | {} | {} | {} |".format(
            question_id, yes(base["in_context"]), yes(variant["in_context"]), queries))
    return "\n".join(lines)


def spend_table() -> str:
    by_stage = ANALYSIS["spend"]["by_stage"]
    validator_p = sum(row["cost_usd"]["validator_usd"] for row in rows() if row["arm"] == "P")
    judge_bb2 = sum(row["judge_usd"] for row in rows() if row["arm"] != "P")
    residual = by_stage["validator"] - validator_p - judge_bb2
    labels = {
        "generator:B": "generator, arm B",
        "generator:B2": "generator, arm B2",
        "generator:B:reread": "generator, arm B (refusal re-read)",
        "generator:B2:reread": "generator, arm B2 (refusal re-read)",
        "writer": "writer, arm P",

        "rerank": "decision rerank",
        "router": "router",
        "planner": "planner",
        "embed": "embeddings",
    }
    lines = ["| Stage | µUSD |", "|---|---:|"]
    for key, label in labels.items():
        lines.append(f"| {label} | {by_stage[key] * 1e6:,.0f} |")
    lines.append(f"| validator, arm P (proposed stage) | {validator_p * 1e6:,.0f} |")
    lines.append(f"| evidence judge, arms B/B2 (measurement only) | {judge_bb2 * 1e6:,.0f} |")
    lines.append(f"| duplicate judge call from the stopped run | {residual * 1e6:,.0f} |")
    lines.append(f"| **Total** | **{ANALYSIS['spend']['usd'] * 1e6:,.0f}** |")
    return "\n".join(lines)


def main() -> None:
    rendered = {
        "TABLES-EVIDENCE": evidence_table(),
        "TABLES-COST": cost_table(),
        "TABLES-AGGREGATE": aggregate_table(),
        "TABLES-PLANS": plan_table(),
        "TABLES-BASELINE": baseline_table(),
        "TABLES-SPEND": spend_table(),
    }
    doc = DOC.read_text()
    for name, table in rendered.items():
        pattern = re.compile(rf"<!-- {name} -->.*?<!-- /{name} -->", re.S)
        doc = pattern.sub(f"<!-- {name} -->\n{table}\n<!-- /{name} -->", doc)
    DOC.write_text(doc)
    print(f"wrote {DOC} ({len(doc.splitlines())} lines)")


if __name__ == "__main__":
    main()
