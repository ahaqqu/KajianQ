#!/usr/bin/env python3
"""The three measurement arms.

B  — today's shape: router reading + production decomposition, one embed call
     for the sub-queries, both embedding tracks, RRF, decision-model rerank,
     production assembler order, production generator prompt.
B2 — B with the caller's question always prepended to the searched set: a
     prototype of the in-review caller-words fix, used only as a confound
     control so a plan-arm gain cannot be mistaken for a planner effect.
P  — obligation plan: planner, per-obligation retrieval (obligation text + the
     caller's question), per-obligation rerank and admission, obligation-by-
     obligation writer, per-obligation validator.

Both arms share the same embedder, retrieval tracks, RRF, reranker, chunk
renderer, generator prompt, DeepSeek model and price table. They differ ONLY in
how retrieval queries are formed, which passages reach the context, and the
writer/validator stage P adds.
"""

from __future__ import annotations

import json
import re
import subprocess

import kq
import plan as planner

INTENTS = ("factual", "ruling", "analogy", "comparison", "history", "aqidah")
SUBJECT_AREAS = ("quran", "hadith", "tafsir", "fikih", "aqidah", "tasawuf",
                 "sejarah", "adab", "general")
PRINCIPLE_TAGS = ("yusr", "rahmah", "masyaqqah", "dharar", "umum_balwa", "istihsan", "sad_zari")
SUB_QUERY_ROLES = ("factual", "principle", "dalil", "sanad")
MAX_PRINCIPLE_TAGS = 3


# --------------------------------------------------------------------- routing


def route(question: str) -> dict:
    """Production's router call and reply reading, with its deterministic fallback."""
    result = kq.chat(
        [{"role": "system", "content": kq.PROMPTS["routerSystemPrompt"]},
         {"role": "user", "content": question}],
        stage="router", temperature=0, max_tokens=900, cache=True,
    )
    parsed = kq.extract_json_object(result["text"])
    intent = parsed.get("intent") if isinstance(parsed, dict) else None
    if intent not in INTENTS:
        return {
            "intent": "factual", "category": None, "needsPrinciple": False,
            "principleTags": [], "modelSubQueries": [], "confidence": None,
            "reasoning": None, "fallback": True,
            "raw": result["text"], "cost": _cost(result),
        }
    tags = [tag for tag in (parsed.get("principleTags") or [])
            if isinstance(tag, str) and tag in PRINCIPLE_TAGS][:MAX_PRINCIPLE_TAGS]
    sub_queries = []
    for entry in parsed.get("subQueries") or []:
        if isinstance(entry, str):
            sub_queries.append({"text": entry.strip()})
        elif isinstance(entry, dict) and isinstance(entry.get("text"), str):
            role = entry.get("role")
            sub_queries.append({
                "text": entry["text"].strip(),
                **({"role": role} if role in SUB_QUERY_ROLES else {}),
            })
    category = parsed.get("category")
    confidence = parsed.get("confidence")
    return {
        "intent": intent,
        "category": category if category in SUBJECT_AREAS else None,
        "needsPrinciple": parsed.get("needsPrinciple") is True,
        "principleTags": tags,
        "modelSubQueries": [entry for entry in sub_queries if entry["text"]],
        "confidence": confidence if isinstance(confidence, (int, float)) else None,
        "reasoning": (parsed.get("reasoning") or "")[:600] if isinstance(parsed.get("reasoning"), str) else None,
        "fallback": False,
        "raw": result["text"],
        "cost": _cost(result),
    }


def decompose(question: str, reading: dict) -> list[dict]:
    """Call the production `decomposeQuery` through its Bun bridge."""
    payload = [{
        "question": question,
        "needsPrinciple": reading["needsPrinciple"],
        "principleTags": reading["principleTags"],
        "category": reading["category"],
        "modelSubQueries": [entry for entry in reading["modelSubQueries"]],
    }]
    proc = subprocess.run(
        ["bun", "research/obligations/decompose.mjs"],
        input=json.dumps(payload), capture_output=True, text=True, cwd=kq.WORKTREE,
    )
    if proc.returncode:
        raise RuntimeError(f"decompose bridge failed: {proc.stderr.strip()[:400]}")
    return json.loads(proc.stdout)[0]


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).lower()


def caller_words_variant(question: str, sub_queries: list[dict]) -> list[dict]:
    """Prototype of the in-review fix: the caller's words always take a slot.

    This is a confound control, not a proposal: the fix is in review elsewhere
    and this harness only needs its retrieval behaviour to tell a planner effect
    apart from it. It mirrors the branch's rule — the caller's entry first, one
    entry per fired role, then model extras, ceiling four.
    """
    normalized_question = _normalize(question)
    if any(_normalize(sub["text"]) == normalized_question for sub in sub_queries):
        return sub_queries
    candidate = [{"text": question.strip(), "role": "factual", "origin": "rule"}] + sub_queries
    kept = [candidate[0]]
    roles = {"factual"}
    for sub in candidate[1:]:
        role = sub.get("role")
        if role and role not in roles:
            kept.append(sub)
            roles.add(role)
    for sub in candidate[1:]:
        if len(kept) >= 4:
            break
        if sub not in kept:
            kept.append(sub)
    return kept[:4]


# ------------------------------------------------------------------- baseline


def baseline_context(question: str, sub_queries: list[dict], intent: str) -> dict:
    """The fan-out arm: one embed call for every sub-query, fuse, rerank, assemble."""
    queries = [sub["text"] for sub in sub_queries]
    retrieval = kq.retrieve(queries, intent)
    rerank = kq.rerank(question, retrieval["chunks"])
    chunks = rerank["chunks"]
    context, ordered = kq.assemble(chunks)
    return {
        "queries": queries,
        "sub_queries": sub_queries,
        "lists": retrieval["lists"],
        "hits": retrieval["hits"],
        "unique": retrieval["unique"],
        "rerank_applied": rerank["applied"],
        "chunks": ordered,
        "context": context,
        "context_labels": _context_labels(ordered),
    }


# ------------------------------------------------------------------ plan arm


def plan_context(question: str, language: str, admit_k: int = planner.ADMIT_K) -> dict:
    """Planner + deterministic per-obligation executor."""
    planned = planner.plan(question)
    obligations = planned["obligations"]
    execution = planner.execute(question, obligations, None, admit_k=admit_k)
    context = planner.render_grouped(question, obligations, execution["chunks"], language)
    return {
        "plan": planned,
        "obligations": obligations,
        "per_obligation": execution["obligations"],
        "chunks": execution["chunks"],
        "admitted_total": execution["admitted_total"],
        "context": context,
        "context_labels": _context_labels(execution["chunks"]),
    }


def _context_labels(chunks: list[dict]) -> list[str]:
    labels = []
    for chunk in chunks:
        normalized = kq.normalize_label(chunk.get("label") or "")
        if normalized:
            labels.append(normalized)
    return labels


# ------------------------------------------------------------------ generation


def _is_pure_refusal(text: str, language: str) -> bool:
    stripped = (text or "").strip().lower()
    refusal = kq.PROMPTS["refusals"][language].lower()
    floor = kq.PROMPTS["refusalFloors"][language]
    floor_text = f"{floor['head']} {kq.PROMPTS['refusals'][language]} {floor['tail']}.".lower()
    return stripped == refusal or stripped == floor_text


def generate(question: str, context: str, language: str, *, stage: str) -> dict:
    """The production generator prompt over the arm's assembled context.

    A pure refusal is reread once on the same evidence, mirroring the stage's
    rule, so a refusal is never a single sample. Nothing else is reread.
    """
    messages = [
        {"role": "system", "content": kq.PROMPTS["chatSystemPrompt"][language]},
        {"role": "user", "content":
            f"Pertanyaan / Question: {question}\n\nKonteks / Context:\n{context}"},
    ]
    result = kq.chat(messages, stage=stage, temperature=None, max_tokens=4096, cache=False)
    draw = {
        "text": result["text"],
        "prompt_tokens": result["prompt_tokens"],
        "completion_tokens": result["completion_tokens"],
        "usd": result["usd"],
        "reread": False,
    }
    if _is_pure_refusal(result["text"], language):
        reread = kq.chat(messages, stage=f"{stage}:reread", temperature=None,
                         max_tokens=4096, cache=False)
        draw.update({
            "text": reread["text"],
            "prompt_tokens": result["prompt_tokens"] + reread["prompt_tokens"],
            "completion_tokens": result["completion_tokens"] + reread["completion_tokens"],
            "usd": result["usd"] + reread["usd"],
            "reread": True,
        })
    return draw


def generate_plan(question: str, context: str, obligations: list[dict],
                  language: str) -> dict:
    """The plan arm's writer: production system prompt, obligation-by-obligation turn."""
    messages = planner.writer_messages(question, context, obligations, language)
    result = kq.chat(messages, stage="writer", temperature=None, max_tokens=4096, cache=False)
    draw = {
        "text": result["text"],
        "prompt_tokens": result["prompt_tokens"],
        "completion_tokens": result["completion_tokens"],
        "usd": result["usd"],
        "reread": False,
    }
    if _is_pure_refusal(result["text"], language):
        reread = kq.chat(messages, stage="writer:reread", temperature=None,
                         max_tokens=4096, cache=False)
        draw.update({
            "text": reread["text"],
            "prompt_tokens": result["prompt_tokens"] + reread["prompt_tokens"],
            "completion_tokens": result["completion_tokens"] + reread["completion_tokens"],
            "usd": result["usd"] + reread["usd"],
            "reread": True,
        })
    return draw


def _cost(result: dict) -> dict:
    return {"prompt_tokens": result["prompt_tokens"],
            "completion_tokens": result["completion_tokens"], "usd": result["usd"]}
