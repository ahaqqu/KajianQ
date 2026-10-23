#!/usr/bin/env python3
"""The obligation plan: planner, deterministic executor, writer, validator.

The schema and the caps are prototype decisions, stated here and in the
research doc so a reader can see exactly what was measured:

* kinds are `definition | comparison | ruling | dalil | scope`, the five the
  brief names;
* a plan carries 1..5 obligations (`MAX_OBLIGATIONS`), and malformed model
  output is repaired deterministically — never by a second model call, which
  would make the arm's cost depend on the failure;
* the executor retrieves `[obligation text, caller's question]` per obligation,
  fuses both embedding tracks by RRF, reranks with the serving decision model,
  and admits the top `admit_k` passages per obligation;
* a passage may serve more than one obligation and is rendered once, carrying
  its serving ids;
* the validator marks each obligation `supported` when at least one admitted
  passage states what the obligation requires, and records which passage the
  answer relied on (`answer_cites`), or null when the answer skipped it.
"""

from __future__ import annotations

import json
import re

import kq

OBLIGATION_KINDS = ("definition", "comparison", "ruling", "dalil", "scope")
MAX_OBLIGATIONS = 5
ADMIT_K = 3

PLANNER_PROMPT = """You are the planning stage of a classical Islamic knowledge retrieval system.
Given the user's question, reply with ONLY a JSON object:
{"obligations": [{"kind": "definition|comparison|ruling|dalil|scope", "text": "a focused retrieval query"}]}

An obligation is one piece of evidence the answer must contain. Write 1 to 5 of them.
Kinds:
- definition: what a named thing is or means.
- comparison: evidence that compares two named things or states how they differ.
- ruling: the ruling on an act (wajib, sunnah, haram, makruh, mubah, sah, batal).
- dalil: the textual proof (ayah or hadith) that states the ruling or the fact.
- scope: who, when, or under which conditions the thing applies.
Rules: one obligation per distinct evidence need; phrase each as a retrieval query in the
question's language; do not answer the question and do not invent citations; no prose outside the JSON."""

WRITER_INSTRUCTION = {
    "id": (
        "Jawablah pertanyaan di atas dengan menjawab kewajiban bukti O1, O2, … satu per satu. "
        "Untuk setiap kewajiban, kutip bukti yang mendukung dan sebutkan label sitasinya."
    ),
    "en": (
        "Answer the question by answering evidence obligations O1, O2, … one by one. "
        "For each obligation, quote the supporting evidence and name its citation label."
    ),
}

VALIDATOR_INSTRUCTION = {
    "id": (
        "Anda memvalidasi apakah bukti yang diambil memenuhi kewajiban bukti. "
        "Tandai supported=true hanya bila sekurang-kurangnya satu bukti di bawah menyatakan apa "
        "yang diminta kewajiban itu; jangan memakai pengetahuan di luar bukti. answer_cites adalah "
        "id bukti yang diandalkan jawaban untuk kewajiban itu, atau null bila jawaban tidak "
        "membahasnya. Jangan mengarang id."
    ),
    "en": (
        "You validate whether the retrieved evidence meets the evidence obligations. Mark "
        "supported=true only when at least one passage below states what the obligation requires; "
        "do not use outside knowledge. answer_cites is the evidence id the answer relies on for "
        "that obligation, or null when the answer does not address it. Never invent ids."
    ),
}


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).lower()


def parse_plan(text: str, question: str) -> dict:
    """Strict, deterministic read of the planner's reply.

    Repair, never a second model call: a bare array or a differently named list
    key is salvaged; an entry outside the kind vocabulary, with no text, or a
    duplicate is dropped; more than the cap is truncated in order. When nothing
    usable survives, the caller's own question becomes one `scope` obligation,
    so the arm never runs on zero obligations — the fallback is recorded.
    """
    repair: list[str] = []
    parsed = kq.extract_json_object(text)
    raw: object = None
    if parsed is not None:
        raw = parsed.get("obligations")
        if raw is None:
            for key in ("plan", "steps", "items"):
                if isinstance(parsed.get(key), list):
                    raw = parsed.get(key)
                    repair.append(f"salvaged:{key}")
                    break
    if raw is None:
        array = _extract_json_array(text)
        if array is not None:
            raw = array
            repair.append("salvaged:top-level-array")
    if not isinstance(raw, list):
        repair.append("fallback:no-list")
        return {
            "obligations": [{"id": "O1", "kind": "scope", "text": question}],
            "repair": repair,
        }
    obligations: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            repair.append(f"dropped:{index}:not-object")
            continue
        kind = str(item.get("kind", "")).strip().lower()
        obligation_text = str(item.get("text", "")).strip()
        if kind not in OBLIGATION_KINDS:
            repair.append(f"dropped:{index}:kind={kind!r}")
            continue
        if not obligation_text:
            repair.append(f"dropped:{index}:empty-text")
            continue
        key = _normalize(obligation_text)
        if key in seen:
            repair.append(f"dropped:{index}:duplicate")
            continue
        seen.add(key)
        obligations.append({"kind": kind, "text": obligation_text})
    if len(obligations) > MAX_OBLIGATIONS:
        repair.append(f"truncated:{len(obligations)}->{MAX_OBLIGATIONS}")
        obligations = obligations[:MAX_OBLIGATIONS]
    if not obligations:
        repair.append("fallback:empty")
        obligations = [{"kind": "scope", "text": question}]
    for number, obligation in enumerate(obligations, start=1):
        obligation["id"] = f"O{number}"
    return {"obligations": obligations, "repair": repair}


def _extract_json_array(text: str) -> list | None:
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, list) else None


def plan(question: str) -> dict:
    """One planner call per question (temperature 0, deterministic repair)."""
    result = kq.chat(
        [{"role": "system", "content": PLANNER_PROMPT},
         {"role": "user", "content": question}],
        stage="planner", temperature=0, max_tokens=900, cache=True,
    )
    parsed = parse_plan(result["text"], question)
    return {
        "obligations": parsed["obligations"],
        "repair": parsed["repair"],
        "raw": result["text"],
        "cost": {"prompt_tokens": result["prompt_tokens"],
                 "completion_tokens": result["completion_tokens"], "usd": result["usd"]},
    }


def execute(question: str, obligations: list[dict], intent: str | None,
            admit_k: int = ADMIT_K) -> dict:
    """Per obligation: retrieve(obligation + question), rerank, admit top-k.

    Deterministic given the plan: the query set is the obligation text and the
    caller's question, always both, so the plan can never displace the caller's
    words the way a model paraphrase can.
    """
    admitted: dict[str, dict] = {}
    per_obligation: list[dict] = []
    for obligation in obligations:
        queries = []
        for text in (obligation["text"], question):
            if _normalize(text) not in {_normalize(q) for q in queries}:
                queries.append(text)
        retrieval = kq.retrieve(queries, intent)
        rerank = kq.rerank(
            f"{question}\nObligation ({obligation['kind']}): {obligation['text']}",
            retrieval["chunks"],
        )
        taken = rerank["chunks"][:admit_k]
        entry = {
            "id": obligation["id"],
            "kind": obligation["kind"],
            "text": obligation["text"],
            "queries": queries,
            "fused": len(retrieval["chunks"]),
            "admitted": [chunk["id"] for chunk in taken],
            "top_probability": (taken[0].get("prob") if taken else None),
            "rerank_applied": rerank["applied"],
        }
        per_obligation.append(entry)
        for chunk in taken:
            existing = admitted.get(chunk["id"])
            if existing is None:
                admitted[chunk["id"]] = {**chunk, "serves": [obligation["id"]]}
                continue
            if obligation["id"] not in existing["serves"]:
                existing["serves"].append(obligation["id"])
            if chunk.get("prob") is not None and (
                existing.get("prob") is None or chunk["prob"] > existing["prob"]
            ):
                existing["prob"] = chunk["prob"]
    chunks = sorted(
        admitted.values(),
        key=lambda c: (-(c.get("prob") if c.get("prob") is not None else c.get("score", 0.0)),
                       c["id"]),
    )
    for number, chunk in enumerate(chunks, start=1):
        chunk["evidence_id"] = f"E{number}"
    return {
        "obligations": per_obligation,
        "chunks": chunks,
        "admitted_total": len(chunks),
    }


def render_grouped(question: str, obligations: list[dict], chunks: list[dict],
                   language: str) -> str:
    """The plan arm's context: one block per obligation, shared passages once."""
    by_obligation: dict[str, list[dict]] = {o["id"]: [] for o in obligations}
    for chunk in chunks:
        first = chunk["serves"][0]
        by_obligation.setdefault(first, []).append(chunk)
    lines: list[str] = []
    for obligation in obligations:
        lines.append(f"### {obligation['id']} [{obligation['kind']}] {obligation['text']}")
        for chunk in by_obligation.get(obligation["id"], []):
            tags = ",".join(chunk["serves"])
            lines.append(f"{chunk['evidence_id']} ({tags}) {kq.render_chunk(chunk)}")
        if not by_obligation.get(obligation["id"]):
            lines.append("(tidak ada bukti yang diambil untuk kewajiban ini)")
    return "\n\n".join(lines)


def writer_messages(question: str, context: str, obligations: list[dict],
                    language: str) -> list[dict]:
    obligation_lines = [
        f"{obligation['id']} [{obligation['kind']}] {obligation['text']}"
        for obligation in obligations
    ]
    user = "\n".join([
        f"Pertanyaan / Question: {question}",
        "",
        "Kewajiban bukti / Evidence obligations (jawab satu per satu):",
        *obligation_lines,
        "",
        "Konteks / Context:",
        context,
        "",
        WRITER_INSTRUCTION[language],
    ])
    return [
        {"role": "system", "content": kq.PROMPTS["chatSystemPrompt"][language]},
        {"role": "user", "content": user},
    ]


def judge(question: str, obligations: list[dict], chunks: list[dict],
          answer: str | None, language: str) -> dict:
    """The per-obligation evidence validator, shared by both arms' obligation table."""
    evidence_lines = []
    for chunk in chunks:
        evidence_lines.append(
            f"{chunk['evidence_id']} [{chunk.get('label') or 'tanpa label'}] "
            f"{kq.render_chunk(chunk)}"
        )
    obligation_lines = [
        f"{obligation['id']} [{obligation['kind']}] {obligation['text']}"
        for obligation in obligations
    ]
    parts = [
        f"Pertanyaan / Question: {question}",
        "",
        "Kewajiban bukti / Evidence obligations:",
        *obligation_lines,
        "",
        "Bukti yang diambil / Retrieved evidence:",
        *evidence_lines,
    ]
    if answer is not None:
        parts += ["", "Jawaban / Answer:", answer]
    parts += [
        "",
        "Balas HANYA JSON:",
        '{"obligations": [{"id": "O1", "supported": true, "evidence": ["E1"], '
        '"answer_cites": "E1" | null, "reason": "one short sentence"}]}',
        "",
        VALIDATOR_INSTRUCTION[language],
    ]
    result = kq.chat(
        [{"role": "user", "content": "\n".join(parts)}],
        stage="validator", temperature=0, max_tokens=1200, cache=True,
    )
    read = read_validator(result["text"], obligations)
    return {"readings": read["readings"], "repair": read["repair"], "raw": result["text"],
            "cost": {"prompt_tokens": result["prompt_tokens"],
                     "completion_tokens": result["completion_tokens"], "usd": result["usd"]}}


def read_validator(text: str, obligations: list[dict]) -> dict:
    """Read the validator's JSON, defaulting an unreadable obligation to unsupported."""
    parsed = kq.extract_json_object(text) or {}
    raw = parsed.get("obligations")
    by_id: dict[str, dict] = {}
    repair: list[str] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            identifier = str(item.get("id", "")).strip().upper()
            if identifier:
                by_id[identifier] = item
    else:
        repair.append("no-obligations-list")
    readings = []
    for obligation in obligations:
        item = by_id.get(obligation["id"])
        if item is None:
            repair.append(f"missing:{obligation['id']}")
            readings.append({
                "id": obligation["id"], "supported": False, "evidence": [],
                "answer_cites": None, "reason": "validator returned no reading",
            })
            continue
        evidence = item.get("evidence")
        evidence_ids = [str(value) for value in evidence] if isinstance(evidence, list) else []
        answer_cites = item.get("answer_cites")
        readings.append({
            "id": obligation["id"],
            "supported": item.get("supported") is True,
            "evidence": evidence_ids,
            "answer_cites": str(answer_cites) if isinstance(answer_cites, str) else None,
            "reason": str(item.get("reason", ""))[:300],
        })
    return {"readings": readings, "repair": repair}
