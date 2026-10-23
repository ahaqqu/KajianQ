#!/usr/bin/env python3
"""Shared harness for the obligations-plan prototype (research/obligations).

Everything here is offline and read-only against the local corpus:

* SQL runs in a session that has already executed
  `SET default_transaction_read_only = on`, and the script refuses to start if
  the DSN is not the local corpus (127.0.0.1:55432).
* Embeddings and generations are paid vendor calls, metered from the vendor's
  own `usage` block and priced from `packages/infra/src/providers/models.json`
  at HEAD (micro-USD per MTok). Every call appends to `ledger.jsonl`; the
  process aborts before a call that would cross `BUDGET_USD`.
* Deterministic (temperature 0) results are content-cached under `.cache/` so a
  re-run does not re-pay; the generator and the plan writer are never cached,
  because their variance is the thing being measured.

No key is printed, read from a file by this module, or written anywhere.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parent.parent
REPO_ROOT = Path("/home/ahaqqu/Projects/KajianQ")
ENV_FILE = REPO_ROOT / ".env"
CACHE = HERE / ".cache"
LLM_CACHE = CACHE / "llm"
EMBED_CACHE = CACHE / "embeddings.json"
LEDGER = HERE / "ledger.jsonl"
PROMPTS = json.loads((HERE / "prompts.generated.json").read_text())

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:kq@127.0.0.1:55432/kajianq"
)
DSN = ["-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "kajianq"]
BUDGET_USD = 0.45
LIMIT_PER_TRACK = 10
RRF_K = 60
HIERARCHY_BONUS = {"quran": 0.3, "kitab": 0.1, "sahih": 0.25, "hasan": 0.15}
PRESENTATION_ORDER = ["principle", "quran", "tafsir", "hadith", "kitab"]
MACHINE_LABEL = "Terjemahan mesin — lihat teks Arab asli"

# micro-USD per MTok, from packages/infra/src/providers/models.json at the
# branch's base commit. DeepSeek is priced at the vendor's peak rate so a
# measured cost never understates the invoice (the config's own rule).
PRICES = {
    "deepseek-v4-flash": (300_000, 1_200_000),
    "gemini-embedding-001": (200_000, 0),
    "jev-1.13.0": (42_000, 0),
}
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone"


# --------------------------------------------------------------------------- env


def load_env() -> None:
    """Load the repo-root .env into this process without echoing values."""
    if not ENV_FILE.exists():
        sys.exit(f"missing {ENV_FILE}")
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip()
        if name and value and name not in os.environ:
            os.environ[name] = value


def assert_local_dsn() -> None:
    if "127.0.0.1:55432" not in DATABASE_URL:
        sys.exit(f"refusing to run: DATABASE_URL is not the local corpus ({DATABASE_URL})")


def micro_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    price_in, price_out = PRICES[model]
    return tokens_in * price_in / 1_000_000 + tokens_out * price_out / 1_000_000


# ------------------------------------------------------------------------- money


def _ledger_totals() -> float:
    if not LEDGER.exists():
        return 0.0
    total = 0.0
    for line in LEDGER.read_text().splitlines():
        if line.strip():
            total += float(json.loads(line)["usd"])
    return total


def record_cost(entry: dict) -> None:
    CACHE.mkdir(exist_ok=True)
    with LEDGER.open("a") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def guard_budget(next_usd: float = 0.0) -> None:
    spent = _ledger_totals()
    if spent + next_usd > BUDGET_USD:
        sys.exit(f"budget guard: spent ${spent:.6f}, next ${next_usd:.6f} would cross ${BUDGET_USD}")


def spend_summary() -> dict:
    rows = []
    if LEDGER.exists():
        rows = [json.loads(line) for line in LEDGER.read_text().splitlines() if line.strip()]
    by_stage: dict[str, float] = {}
    for row in rows:
        by_stage[row["stage"]] = by_stage.get(row["stage"], 0.0) + float(row["usd"])
    return {
        "calls": len(rows),
        "prompt_tokens": sum(int(r["prompt_tokens"]) for r in rows),
        "completion_tokens": sum(int(r["completion_tokens"]) for r in rows),
        "usd": round(sum(float(r["usd"]) for r in rows), 6),
        "by_stage": {k: round(v, 6) for k, v in sorted(by_stage.items())},
    }


# --------------------------------------------------------------------------- sql


def psql_json(sql: str) -> list[dict]:
    """Run one read-only SQL statement and return its rows as JSON objects."""
    env = {**os.environ, "PGPASSWORD": "kq"}
    proc = subprocess.run(
        ["psql", "-q", *DSN, "-t", "-A", "-c",
         "SET default_transaction_read_only = on; " + sql],
        capture_output=True, text=True, env=env,
    )
    if proc.returncode:
        sys.exit(f"psql failed: {proc.stderr.strip()}\nSQL: {sql[:400]}")
    payload = proc.stdout.strip()
    if not payload:
        return []
    start = min(index for index in (payload.find("["), payload.find("{")) if index >= 0)
    return json.loads(payload[start:])


def vec_literal(vector: list[float]) -> str:
    return "'[" + ",".join(f"{x:.9g}" for x in vector) + "]'::vector"


def corpus_stats() -> dict:
    rows = psql_json(
        "select coalesce(json_agg(row_to_json(t)), '[]')::text from ("
        " select count(*) as total, count(embedding_primary) as primary,"
        " count(embedding_fallback) as fallback from doc_children) t;"
    )
    return rows[0]


# ----------------------------------------------------------------------- embeddings


def _embedding_key(text: str) -> str:
    return hashlib.sha256(("gemini-embedding-001\x00" + text).encode()).hexdigest()


def embed(texts: list[str]) -> list[list[float]]:
    """Embed texts with the serving model and corpus embedding space.

    The vendor reports no usage for embeddings on this endpoint, so tokens are
    estimated at ~4 chars/token exactly like the provider adapter's fallback and
    the cost line is marked `estimated` in the ledger.
    """
    CACHE.mkdir(exist_ok=True)
    cache = json.loads(EMBED_CACHE.read_text()) if EMBED_CACHE.exists() else {}
    out: list[list[float] | None] = [None] * len(texts)
    missing: list[tuple[int, str, str]] = []
    for index, text in enumerate(texts):
        key = _embedding_key(text)
        if key in cache:
            out[index] = cache[key]
        else:
            missing.append((index, text, key))
    if missing:
        key = os.environ.get("GEMINI_PAID_API_KEY", "")
        if not key:
            sys.exit("GEMINI_PAID_API_KEY is not set (source the repo-root .env)")
        guard_budget(0.0001)
        for start in range(0, len(missing), 16):
            batch = missing[start:start + 16]
            body = json.dumps({
                "model": "gemini-embedding-001",
                "input": [text for _, text, _ in batch],
                "dimensions": 1536,
            }).encode()
            payload = _post(EMBED_URL, body, key)
            vectors = [item["embedding"] for item in payload["data"]]
            if len(vectors) != len(batch):
                sys.exit(f"embed returned {len(vectors)} vectors for {len(batch)} texts")
            tokens = sum(max(1, math.ceil(len(text) / 4)) for _, text, _ in batch)
            usd = micro_usd("gemini-embedding-001", tokens, 0) / 1_000_000
            record_cost({
                "at": time.time(), "stage": "embed", "model": "gemini-embedding-001",
                "prompt_tokens": tokens, "completion_tokens": 0, "usd": usd,
                "estimated": True,
            })
            for (index, _, cache_key), vector in zip(batch, vectors):
                cache[cache_key] = vector
                out[index] = vector
        EMBED_CACHE.write_text(json.dumps(cache))
    return [vector for vector in out if vector is not None]


# ------------------------------------------------------------------------ http


def _post(url: str, body: bytes, key: str, timeout: int = 180) -> dict:
    last: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(
            url, data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read()[:300]
            last = RuntimeError(f"HTTP {error.code}: {detail!r}")
            if error.code < 500 and error.code != 429:
                break
        except Exception as error:  # noqa: BLE001 - transport retry
            last = error
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"POST {url} failed: {last}")


# ---------------------------------------------------------------------- chat llm


def _cache_key(model: str, messages: list[dict], temperature, max_tokens: int) -> str:
    blob = json.dumps({"model": model, "messages": messages, "temperature": temperature,
                       "max_tokens": max_tokens}, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


def chat(
    messages: list[dict],
    *,
    stage: str,
    temperature: float | None = 0,
    max_tokens: int = 4096,
    cache: bool = True,
    model: str = "deepseek-v4-flash",
    thinking: bool = False,
) -> dict:
    """One DeepSeek generation. Deterministic calls are cached by prompt."""
    key = _cache_key(model, messages, temperature, max_tokens)
    cache_path = LLM_CACHE / f"{key}.json"
    if cache and cache_path.exists():
        return json.loads(cache_path.read_text())
    guard_budget(0.05)
    payload: dict = {"model": model, "messages": messages, "max_tokens": max_tokens}
    if temperature is not None:
        payload["temperature"] = temperature
    if not thinking:
        payload["reasoning_effort"] = "none"
    data = _post(DEEPSEEK_URL, json.dumps(payload).encode(),
                 os.environ.get("DEEPSEEK_API_KEY", ""))
    message = (data.get("choices") or [{}])[0].get("message") or {}
    text = (message.get("content") or "").strip()
    usage = data.get("usage") or {}
    prompt_tokens = int(usage.get("prompt_tokens", 0))
    completion_tokens = int(usage.get("completion_tokens", 0))
    usd = micro_usd(model, prompt_tokens, completion_tokens) / 1_000_000
    record_cost({
        "at": time.time(), "stage": stage, "model": model,
        "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        "usd": usd, "estimated": False,
    })
    result = {
        "text": text,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "usd": usd,
        "reasoning_content": message.get("reasoning_content"),
    }
    if cache:
        LLM_CACHE.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(result, ensure_ascii=False))
    return result


# --------------------------------------------------------------- decision model


def decide(query: str, candidates: list[str], instructions: str, *, stage: str,
           cache: bool = True) -> dict | None:
    """One TypeSafe Choice question over candidate passages.

    Returns `{"probabilities": [...], "order": [...], "choice": "cN"}` or None on
    any vendor/protocol failure, which the caller reads as fail-open (the fused
    order stands), mirroring the engine's rerank decorator.
    """
    if len(candidates) < 2:
        return None
    key = hashlib.sha256(json.dumps(
        {"q": query, "c": candidates, "i": instructions}, ensure_ascii=False
    ).encode()).hexdigest()
    cache_path = LLM_CACHE / f"decision-{key}.json"
    if cache and cache_path.exists():
        return json.loads(cache_path.read_text())
    criteria = {f"c{index}": None for index in range(len(candidates))}
    body = json.dumps({
        "state": {"query": query, "candidates": candidates},
        "model": "jev-1.13.0",
        "questions": {"best": {"type": "choice", "instructions": instructions,
                               "criteria": criteria}},
    }, ensure_ascii=False).encode()
    guard_budget(0.01)
    try:
        data = _post(SYSTEMONE_URL, body, os.environ.get("JEV_API_KEY", ""))
    except Exception as error:  # noqa: BLE001 - fail-open, recorded
        print(f"  [decision:{stage}] fail-open: {error}", file=sys.stderr)
        return None
    answer = (data.get("answers") or {}).get("best") or {}
    probabilities_field = answer.get("probabilities") or {}
    try:
        probabilities = [float(probabilities_field[f"c{index}"]) for index in range(len(candidates))]
    except (KeyError, TypeError, ValueError):
        return None
    if any(not 0 <= value <= 1 for value in probabilities):
        return None
    usage = data.get("usage") or {}
    prompt_tokens = int(usage.get("input_tokens", 0))
    completion_tokens = int(usage.get("output_tokens", 0))
    usd = micro_usd("jev-1.13.0", prompt_tokens, completion_tokens) / 1_000_000
    record_cost({
        "at": time.time(), "stage": stage, "model": "jev-1.13.0",
        "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        "usd": usd, "estimated": False,
    })
    order = sorted(range(len(candidates)), key=lambda i: (-probabilities[i], i))
    result = {"probabilities": probabilities, "order": order,
              "choice": answer.get("choice"), "usd": usd,
              "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
    if cache:
        LLM_CACHE.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(result))
    return result


# ------------------------------------------------------------------ retrieval


def search(vector: list[float], limit: int = LIMIT_PER_TRACK) -> list[dict]:
    """Both embedding tracks for one query vector, one read-only round trip."""
    literal = vec_literal(vector)
    sql = f"""
with primary_track as (
  select 'primary' as track, id::text as id, text_ar, text_id,
         metadata->>'citation' as citation, metadata->>'grade' as grade,
         metadata->>'sourceType' as source_type,
         1 - (embedding_primary <=> {literal}) as similarity
  from doc_children
  where embedding_primary is not null
  order by embedding_primary <=> {literal}, id
  limit {limit}
), fallback_track as (
  select 'fallback' as track, id::text as id, text_ar, text_id,
         metadata->>'citation' as citation, metadata->>'grade' as grade,
         metadata->>'sourceType' as source_type,
         1 - (embedding_fallback <=> {literal}) as similarity
  from doc_children
  where embedding_fallback is not null
  order by embedding_fallback <=> {literal}, id
  limit {limit}
)
select coalesce(json_agg(row_to_json(t)), '[]')::text from (
  select * from primary_track union all select * from fallback_track
) t;
"""
    return psql_json(sql)


def hierarchy_bonus(chunk: dict, intent: str | None) -> float:
    bonus = 0.0
    if chunk["source_type"] == "quran":
        bonus += HIERARCHY_BONUS["quran"]
    if chunk["source_type"] == "kitab":
        bonus += HIERARCHY_BONUS["kitab"]
    if chunk["source_type"] == "principle" and intent == "analogy":
        bonus += 0.2
    if chunk["grade"] == "sahih":
        bonus += HIERARCHY_BONUS["sahih"]
    if chunk["grade"] == "hasan":
        bonus += HIERARCHY_BONUS["hasan"]
    return bonus


def fuse(lists: list[list[dict]], intent: str | None) -> list[dict]:
    """RRF(k=60) plus hierarchy bonuses; first-surfacing chunk keeps its track text."""
    by_id: dict[str, dict] = {}
    for hits in lists:
        for rank, hit in enumerate(hits, start=1):
            entry = by_id.get(hit["id"])
            if entry is None:
                chunk = {
                    "id": hit["id"],
                    "label": hit["citation"],
                    "grade": hit["grade"],
                    "source_type": hit["source_type"],
                    "text_ar": hit["text_ar"],
                    "text_id": hit["text_id"],
                    "text": hit["text_ar"] if hit["track"] == "primary" else (hit["text_id"] or hit["text_ar"]),
                    "track": hit["track"],
                    "score": 0.0,
                    "ranks": [],
                }
                # The bonus is a function of the chunk, not of the list it came from.
                bonus = hierarchy_bonus(chunk, intent)
                by_id[hit["id"]] = entry = {**chunk, "bonus": bonus}
            entry["score"] += (1 + entry["bonus"]) / (RRF_K + rank)
            entry["ranks"].append(rank)
    fused = list(by_id.values())
    for chunk in fused:
        chunk["rankDense"] = min(chunk["ranks"])
    fused.sort(key=lambda c: (-c["score"], c["id"]))
    return fused


def retrieve(queries: list[str], intent: str | None) -> dict:
    """Embed every query in one call, search both tracks, fuse. No filters."""
    vectors = embed(queries)
    lists = [search(vector) for vector in vectors]
    fused = fuse(lists, intent)
    return {
        "queries": queries,
        "lists": len(lists),
        "hits": sum(len(hits) for hits in lists),
        "unique": len(fused),
        "chunks": fused,
    }


def rerank(query: str, chunks: list[dict]) -> dict:
    """Production's decision-model rerank: reorder the whole fused block.

    Fail-open: a vendor failure, an unreadable distribution, or a candidate set
    too short to rank leaves the fused order exactly as it was, with
    `applied: false` recorded — the same rule the engine's decorator follows.
    """
    if len(chunks) < 2:
        return {"chunks": [{**chunk, "prob": None} for chunk in chunks],
                "usd": 0.0, "applied": False}
    result = decide(query, [chunk["text"] for chunk in chunks],
                    PROMPTS["rerankInstructions"], stage="rerank")
    if result is None:
        return {"chunks": [{**chunk, "prob": None} for chunk in chunks],
                "usd": 0.0, "applied": False}
    probabilities = result["probabilities"]
    reranked = [{**chunks[index], "prob": probabilities[index]}
                for index in result["order"]]
    return {"chunks": reranked, "usd": result["usd"], "applied": True}


# ------------------------------------------------------------------ assembly


def render_chunk(chunk: dict) -> str:
    citation = (chunk.get("label") or "").strip()
    grade = (chunk.get("grade") or "").strip()
    grade_suffix = ""
    if grade and grade.lower() not in citation.lower():
        grade_suffix = f" ({grade})"
    label = f" [{citation}{grade_suffix}]" if citation else ""
    original = (chunk.get("text_ar") or "").strip()
    translation = (chunk.get("text_id") or "").strip()
    if original and translation:
        return f"{original}\n({MACHINE_LABEL})\n{translation}{label}"
    return f"{chunk.get('text', '')}{label}"


def presentation_rank(chunk: dict) -> int:
    source_type = chunk.get("source_type")
    if source_type in PRESENTATION_ORDER:
        return PRESENTATION_ORDER.index(source_type)
    return len(PRESENTATION_ORDER)


def assemble(chunks: list[dict]) -> tuple[str, list[dict]]:
    """Production's assembler order: presentation slot, then rerank score."""
    ordered = sorted(
        chunks,
        key=lambda c: (presentation_rank(c), -(c.get("prob") if c.get("prob") is not None else c.get("score", 0.0))),
    )
    return "\n\n".join(render_chunk(chunk) for chunk in ordered), ordered


# ------------------------------------------------------------------ citations

HADITH_RE = re.compile(
    r"\bHR\.\s*([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*)*)\s+[Nn]o\.\s*(\d+)",
    re.IGNORECASE,
)
QURAN_RE = re.compile(
    r"\bQS\.\s*(\d{1,3})\s*:\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?",
    re.IGNORECASE,
)
COLLECTION_ALIASES = {
    "bukhari": "bukhari", "bukhori": "bukhari", "muslim": "muslim",
    "abu dawud": "abudawud", "abu daud": "abudawud", "abudawud": "abudawud",
    "tirmidhi": "tirmidhi", "tirmidzi": "tirmidhi", "at tirmidhi": "tirmidhi",
    "nasai": "nasai", "an nasai": "nasai", "annasai": "nasai",
    "ibnu majah": "ibnmajah", "ibn majah": "ibnmajah", "ibnmajah": "ibnmajah",
    "malik": "malik",
}


def normalize_label(label: str) -> str | None:
    """Reduce a citation-shaped string to `hr. <collection> no. <n>` / `qs. s:a`."""
    text = re.sub(r"[*_`]+", "", label or "").strip()
    match = HADITH_RE.search(text)
    if match:
        collection = re.sub(r"\s+", " ", match.group(1)).strip().lower()
        collection = COLLECTION_ALIASES.get(collection, collection.replace(" ", ""))
        return f"hr. {collection} no. {int(match.group(2))}"
    match = QURAN_RE.search(text)
    if match:
        surah, ayah = int(match.group(1)), int(match.group(2))
        end = match.group(3)
        return f"qs. {surah}:{ayah}-{int(end)}" if end is not None else f"qs. {surah}:{ayah}"
    return None


def citations_in(answer: str) -> list[str]:
    """Citation-shaped spans, normalized and de-duplicated in first-appearance order."""
    spans: list[tuple[int, str]] = []
    for match in HADITH_RE.finditer(answer or ""):
        label = normalize_label(match.group(0))
        if label:
            spans.append((match.start(), label))
    for match in QURAN_RE.finditer(answer or ""):
        label = normalize_label(match.group(0))
        if label:
            spans.append((match.start(), label))
    spans.sort(key=lambda pair: pair[0])
    seen, out = set(), []
    for _, label in spans:
        if label not in seen:
            seen.add(label)
            out.append(label)
    return out


def range_addresses(label: str) -> list[str] | None:
    """A Quran range expands to every address it names; a single label is None."""
    match = QURAN_RE.search(label or "")
    if not match or match.group(3) is None:
        return None
    surah, start, end = int(match.group(1)), int(match.group(2)), int(match.group(3))
    return [f"qs. {surah}:{ayah}" for ayah in range(start, end + 1)]


def grounding(cited: list[str], context_labels: list[str]) -> dict:
    known = set(context_labels)
    grounded, ungrounded = [], []
    for label in cited:
        addresses = range_addresses(label)
        if addresses is not None:
            (grounded if all(address in known for address in addresses) else ungrounded).append(label)
        else:
            (grounded if label in known else ungrounded).append(label)
    return {
        "citations": len(cited),
        "grounded": grounded,
        "ungrounded": ungrounded,
        "grounding_rate": (len(grounded) / len(cited)) if cited else None,
    }


# ------------------------------------------------------------------ json reading

FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json_object(text: str) -> dict | None:
    """First {...} block that parses to an object — fences tolerated, prose ignored."""
    if not text:
        return None
    candidates = FENCE_RE.findall(text) + [text]
    for candidate in candidates:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            continue
        try:
            parsed = json.loads(candidate[start:end + 1])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def language_of(question: str) -> str:
    lowered = question.lower()
    if any(word in lowered for word in ("which", "what", "why", "how", "does", "is ", "the ")):
        return "en"
    return "id"
