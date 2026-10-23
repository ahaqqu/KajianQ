#!/usr/bin/env python3
"""E6 — the measurement tables, from the saved experiment JSON.

No paid call is made here. Retrieval is replayed from the deterministic
harness (cached embeddings, read-only SQL, cached decision files, zero LLM
calls) so each arm's *list-price* cost can be reconstructed stage by stage even
where a re-run hit a cache. The reconstruction is checked against the recorded
context labels; a mismatch fails the script, because a cost table built on a
different retrieval than the measured one would be a fabricated number.

Requirement states are computed twice:

* `exact` — the declared required label(s) (Golden Set, or researcher-declared
  where the Golden Set has no row);
* `identity` — the same requirement widened to the narration's identity class:
  the owner-signed `hadith-identities-v0` group for `gs-v0-006`, and a
  researcher-declared corpus query for the Jibril narration and the
  mother/father narration (`identity-classes.json` records both, with the
  query). Rows with no class keep the exact requirement.

Usage:
  python3 research/obligations/analysis.py
"""

from __future__ import annotations

import json
from pathlib import Path

import kq
import plan as planner

HERE = Path(__file__).resolve().parent
PLANS = {row["question_id"]: row for row in json.loads((HERE / "e1-plans.json").read_text())}
RESULTS = json.loads((HERE / "results-main.json").read_text())
IDENTITY = json.loads((HERE / "identity-classes.json").read_text())["classes"]
QUESTIONS = {row["id"]: row for row in __import__("questions").QUESTIONS}
EMBED_CACHE = json.loads((HERE / ".cache" / "embeddings.json").read_text())


# ------------------------------------------------------------------ helpers


def cached_vector(text: str) -> list[float] | None:
    return EMBED_CACHE.get(kq._embedding_key(text))


def decision_cost_usd(query: str, candidates: list[str]) -> tuple[float, bool]:
    blob = json.dumps({"q": query, "c": candidates, "i": kq.PROMPTS["rerankInstructions"]},
                      ensure_ascii=False)
    key = __import__("hashlib").sha256(blob.encode()).hexdigest()
    path = HERE / ".cache" / "llm" / f"decision-{key}.json"
    if not path.exists():
        return 0.0, False
    record = json.loads(path.read_text())
    # 42,000 µUSD per MTok = 0.042 µUSD per token = 4.2e-8 USD per token.
    return record["prompt_tokens"] * 42_000 / 1e12, True


def embed_cost_usd(texts: list[str]) -> float:
    tokens = sum(max(1, -(-len(text) // 4)) for text in texts)
    # 200,000 µUSD per MTok = 0.2 µUSD per token = 2e-7 USD per token.
    return tokens * 200_000 / 1e12


def router_cost_usd(question: str) -> float:
    messages = [{"role": "system", "content": kq.PROMPTS["routerSystemPrompt"]},
                {"role": "user", "content": question}]
    key = kq._cache_key("deepseek-v4-flash", messages, 0, 900)
    path = HERE / ".cache" / "llm" / f"{key}.json"
    if not path.exists():
        return 0.0
    return json.loads(path.read_text())["usd"]


def replay_fanout(question: str, queries: list[str], intent: str) -> list[dict]:
    vectors = [cached_vector(text) for text in queries]
    if any(vector is None for vector in vectors):
        raise SystemExit(f"missing cached embedding for {question}: {queries}")
    lists = [kq.search(vector) for vector in vectors]
    return kq.rerank(question, kq.fuse(lists, intent))


def replay_plan(question: str, obligations: list[dict], admit_k: int = planner.ADMIT_K) -> dict:
    total = 0.0
    embed_texts: list[str] = []
    chunks: dict[str, dict] = {}
    for obligation in obligations:
        queries = []
        for text in (obligation["text"], question):
            if text.strip().lower() not in {q.strip().lower() for q in queries}:
                queries.append(text)
        embed_texts.extend(queries)
        vectors = [cached_vector(text) for text in queries]
        if any(vector is None for vector in vectors):
            raise SystemExit(f"missing cached embedding for {question}: {queries}")
        fused = kq.fuse([kq.search(vector) for vector in vectors], None)
        query = f"{question}\nObligation ({obligation['kind']}): {obligation['text']}"
        usd, found = decision_cost_usd(query, [chunk["text"] for chunk in fused])
        total += usd
        # Replay the rerank through the cached decision file only: no call, and
        # the recorded order is reproduced from the cached distribution.
        blob = json.dumps({"q": query, "c": [chunk["text"] for chunk in fused],
                           "i": kq.PROMPTS["rerankInstructions"]}, ensure_ascii=False)
        path = HERE / ".cache" / "llm" / f"decision-{__import__('hashlib').sha256(blob.encode()).hexdigest()}.json"
        ordered = fused
        if found and path.exists():
            order = json.loads(path.read_text())["order"]
            ordered = [fused[index] for index in order]
        for chunk in ordered[:admit_k]:
            chunks.setdefault(chunk["id"], {**chunk, "serves": []})
            if obligation["id"] not in chunks[chunk["id"]]["serves"]:
                chunks[chunk["id"]]["serves"].append(obligation["id"])
    return {"chunks": list(chunks.values()), "rerank_usd": total,
            "embed_usd": embed_cost_usd(embed_texts)}


def requirement_state(groups: list[list[str]], labels: list[str], cited: list[str]) -> dict:
    known, cited_set = set(labels), set(cited)
    detail = [{"group": group,
               "in_context": [label for label in group if label in known],
               "cited": [label for label in group if label in cited_set]} for group in groups]
    return {"in_context": all(item["in_context"] for item in detail),
            "cited": all(item["cited"] for item in detail),
            "detail": detail}


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


# ---------------------------------------------------------------- analysis


def main() -> None:
    kq.load_env()
    tables = []
    for record in RESULTS:
        question = QUESTIONS[record["question_id"]]
        labels = record["context_labels"]
        draws = record["answers"]
        arm = record["arm"]
        cost = {"router_usd": 0.0, "planner_usd": 0.0, "embed_usd": 0.0,
                "rerank_usd": 0.0, "writer_usd": 0.0, "validator_usd": 0.0}
        if arm in ("B", "B2"):
            queries = [sub["text"] for sub in record["sub_queries"]]
            replay = replay_fanout(question["question"], queries,
                                   record["route"]["intent"])
            replay_labels = sorted(kq.normalize_label(chunk.get("label") or "")
                                   for chunk in replay["chunks"])
            if replay_labels != sorted(labels):
                raise SystemExit(f"replay mismatch {record['question_id']} {arm}")
            cost["router_usd"] = router_cost_usd(question["question"])
            cost["embed_usd"] = embed_cost_usd(queries)
            cost["rerank_usd"] = replay["usd"]
        else:
            replay = replay_plan(question["question"], record["obligations"])
            replay_labels = sorted(kq.normalize_label(chunk.get("label") or "")
                                   for chunk in replay["chunks"])
            if replay_labels != sorted(labels):
                raise SystemExit(f"replay mismatch {record['question_id']} {arm}")
            cost["planner_usd"] = PLANS[question["id"]]["cost"]["usd"]
            cost["embed_usd"] = replay["embed_usd"]
            cost["rerank_usd"] = replay["rerank_usd"]
            cost["validator_usd"] = record["judge"]["cost"]["usd"]
        generation_usd = sum(draw["usd"] for draw in draws)
        generation_per_draw = generation_usd / len(draws)
        per_answer = (sum(cost.values()) + generation_per_draw)
        citation_counts = [len(draw["grounding"]["grounded"]) for draw in draws]
        ungrounded = [label for draw in draws for label in draw["grounding"]["ungrounded"]]
        grounded_rates = [draw["grounding"]["grounding_rate"] for draw in draws
                          if draw["grounding"]["grounding_rate"] is not None]
        exact_states = [requirement_state(question["required_groups"], labels, draw["citations"])
                        for draw in draws]
        identity_groups = IDENTITY[question["id"]]["groups"]
        identity_states = [requirement_state(identity_groups, labels, draw["citations"])
                           for draw in draws]
        identity_context = requirement_state(identity_groups, labels, [])
        table = {
            "question_id": question["id"],
            "question": question["question"],
            "kind": question["kind"],
            "arm": arm,
            "draws": len(draws),
            "obligations": len(record["obligations"]),
            "obligations_supported": sum(1 for reading in record["judge"]["readings"]
                                         if reading["supported"]),
            "obligation_readings": record["judge"]["readings"],
            "exact_context": requirement_state(question["required_groups"], labels, []),
            "identity_context": identity_context,
            "exact_cited_draws": sum(1 for state in exact_states if state["cited"]),
            "identity_cited_draws": sum(1 for state in identity_states if state["cited"]),
            "citations_per_draw": citation_counts,
            "ungrounded_citations": ungrounded,
            "grounding_rate_mean": mean(grounded_rates),
            "grounding_rate_per_draw": grounded_rates,
            "refusals": sum(1 for draw in draws if draw["refusal"]),
            "prompt_tokens": mean([draw["prompt_tokens"] for draw in draws]),
            "completion_tokens": mean([draw["completion_tokens"] for draw in draws]),
            "context_chars": record["context_chars"],
            "context_chunks": len(labels),
            "cost_usd": {key: round(value, 6) for key, value in cost.items()},
            "judge_usd": record["judge"]["cost"]["usd"],
            "generation_usd_per_draw": round(generation_per_draw, 6),
            "per_answer_usd": round(per_answer, 6),
            "per_answer_micro_usd": round(per_answer * 1e6, 1),
        }
        tables.append(table)

    analysis = {
        "tables": tables,
        "spend": kq.spend_summary(),
        "identity_sources": {key: value["source"] for key, value in IDENTITY.items()},
    }
    (HERE / "analysis.json").write_text(json.dumps(analysis, indent=1, ensure_ascii=False) + "\n")

    header = ("question", "arm", "draws", "obl", "obl_sat", "ctx_chunks", "ctx_chars",
              "req_exact_ctx", "req_ident_ctx", "req_exact_cited", "req_ident_cited",
              "cites", "ground", "ungrounded", "refusals", "prompt", "compl",
              "gen_usd", "answer_usd")
    print(" | ".join(header))
    for row in tables:
        print(" | ".join(str(value) for value in (
            row["question_id"], row["arm"], row["draws"], row["obligations"],
            f"{row['obligations_supported']}/{row['obligations']}",
            row["context_chunks"], row["context_chars"],
            row["exact_context"]["in_context"], row["identity_context"]["in_context"],
            f"{row['exact_cited_draws']}/{row['draws']}",
            f"{row['identity_cited_draws']}/{row['draws']}",
            f"{min(row['citations_per_draw'])}-{max(row['citations_per_draw'])}",
            (f"{row['grounding_rate_mean']:.2f}" if row["grounding_rate_mean"] is not None else "—"),
            len(row["ungrounded_citations"]), row["refusals"],
            int(row["prompt_tokens"] or 0), int(row["completion_tokens"] or 0),
            f"{row['generation_usd_per_draw']:.6f}",
            f"{row['per_answer_micro_usd']:.1f}")))
    print(f"\nspend: {json.dumps(kq.spend_summary(), sort_keys=True)}")
    print("\ncost components per answer (µUSD):")
    for row in tables:
        parts = ", ".join(f"{key.removesuffix('_usd')}={value * 1e6:.1f}"
                          for key, value in row["cost_usd"].items() if value)
        print(f"  {row['question_id']} {row['arm']}: generation={row['generation_usd_per_draw'] * 1e6:.1f}; {parts}")


if __name__ == "__main__":
    main()
