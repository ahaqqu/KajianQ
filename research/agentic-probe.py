#!/usr/bin/env python3
"""Spike: a bounded tool loop over the read-only corpus.

Answers Golden Set questions with a model that may call five retrieval tools, so we can
measure whether query reformulation and verified address fetches reach evidence that the
single dense pass misses. See docs/research/agentic-probe.md for the findings.

This is a research harness, not product code: no trace record, no cost ledger, no
retries. Any production adoption must move it behind the pipeline seams and trace every
tool call.

Environment: GEMINI_API_KEY (query embeddings), DEEPSEEK_API_KEY (generation), and
PGPASSWORD (libpq's standard variable) for Postgres; a local .env is read when present
for the first two. Override the database with
KQ_PGHOST / KQ_PGPORT / KQ_PGUSER / KQ_PGDATABASE.

    python3 research/agentic-probe.py gs-v0-007 gs-v0-016

Exits non-zero when a requested question id is unknown.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = {
    "host": os.environ.get("KQ_PGHOST", "127.0.0.1"),
    "port": os.environ.get("KQ_PGPORT", "55432"),
    "user": os.environ.get("KQ_PGUSER", "postgres"),
    "database": os.environ.get("KQ_PGDATABASE", "kajianq"),
}
GEMINI_MODEL = "gemini-embedding-001"
CHAT_MODEL = "deepseek-chat"
MAX_ITERATIONS = 10


def load_dotenv() -> None:
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def sql(query: str) -> list[list[str]]:
    """Read-only query, tab-separated, newlines folded so one row is one line."""
    completed = subprocess.run(
        [
            "psql", "-h", DB["host"], "-p", DB["port"], "-U", DB["user"],
            "-d", DB["database"], "-tA", "-F", "\t", "-c",
            "SET default_transaction_read_only = on; " + query,
        ],
        capture_output=True, text=True,
        env={**os.environ, "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-400:])
    return [line.split("\t") for line in completed.stdout.splitlines()
            if line and line != "SET"]


def text(column: str) -> str:
    """Fold newlines inside a text column so the line protocol stays intact."""
    return f"regexp_replace(coalesce({column}, ''), E'[\\n\\r\\t]+', ' ', 'g')"


def embed(query: str) -> str:
    response = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
        headers={"Authorization": f"Bearer {os.environ['GEMINI_API_KEY']}"},
        json={"model": GEMINI_MODEL, "input": [query], "dimensions": 1536},
        timeout=90,
    )
    response.raise_for_status()
    values = response.json()["data"][0]["embedding"]
    return "[" + ",".join(f"{value:.6f}" for value in values) + "]"


def label(source: str, first: str, second: str) -> str:
    return f"QS. {first}:{second}" if source == "quran" else f"HR. {first} no. {second}"


def search(source: str, query: str, k: int = 5) -> str:
    vector = embed(query)
    if source == "quran":
        rows = sql(f"""select {text("metadata->>'surah'")}, {text("metadata->>'ayah'")}, {text("text_id")}
            from doc_children where metadata->>'sourceType' = 'quran'
            order by embedding_fallback <=> '{vector}'::vector limit {k}""")
        return "\n".join(f"{label('quran', r[0], r[1])} | {r[2][:400]}" for r in rows) or "no results"
    rows = sql(f"""select {text("citation->>'collection'")}, {text("citation->>'hadithNo'")}, {text("text_id")}
        from doc_children where metadata->>'sourceType' = 'hadith'
        order by embedding_fallback <=> '{vector}'::vector limit {k}""")
    return "\n".join(f"{label('hadith', r[0], r[1])} | {r[2][:400]}" for r in rows) or "no results"


def get_verse(surah: int, ayah: int) -> str:
    rows = sql(f"""select {text("text_id")}, left({text("text_ar")}, 300) from doc_children
        where metadata->>'sourceType' = 'quran'
        and metadata->>'surah' = '{int(surah)}' and metadata->>'ayah' = '{int(ayah)}' limit 1""")
    if not rows:
        return f"QS. {surah}:{ayah} not found"
    return f"QS. {surah}:{ayah} | {rows[0][0][:900]} | AR: {rows[0][1][:200]}"


def get_hadith(collection: str, number: str) -> str:
    safe = collection.lower().replace("'", "")
    rows = sql(f"""select {text("text_id")}, {text("metadata->>'grade'")}, {text("text_ar")}
        from doc_children where metadata->>'sourceType' = 'hadith'
        and lower(citation->>'collection') = lower('{safe}')
        and citation->>'hadithNo' = '{number}' limit 1""")
    if not rows:
        return f"HR. {collection} no. {number} not found"
    grade = rows[0][1] or "none"
    return f"HR. {collection} no. {number} (grade: {grade}) | {rows[0][0][:900]} | AR: {rows[0][2][:200]}"


def find_parallel(collection: str, number: str, k: int = 5) -> str:
    safe = collection.lower().replace("'", "")
    anchor = sql(f"""select id from doc_children where lower(citation->>'collection') = lower('{safe}')
        and citation->>'hadithNo' = '{number}' limit 1""")
    if not anchor:
        return f"HR. {collection} no. {number} not found"
    rows = sql(f"""select {text("citation->>'collection'")}, {text("citation->>'hadithNo'")}, {text("text_id")},
        round((1 - (embedding_primary <=> (select embedding_primary from doc_children where id = '{anchor[0][0]}')))::numeric, 3)
        from doc_children where id <> '{anchor[0][0]}' and metadata->>'sourceType' = 'hadith'
        order by embedding_primary <=> (select embedding_primary from doc_children
          where id = '{anchor[0][0]}') limit {k}""")
    return "\n".join(f"{label('hadith', r[0], r[1])} | {r[2][:300]} [sim {r[3]}]" for r in rows)


TOOLS = [
    {"type": "function", "function": {
        "name": "search_quran",
        "description": "Semantic search over Quran verses (Indonesian translation). Returns addresses and text.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "k": {"type": "integer"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "get_verse", "description": "Fetch one Quran verse by surah and ayah.",
        "parameters": {"type": "object", "properties": {
            "surah": {"type": "integer"}, "ayah": {"type": "integer"}},
            "required": ["surah", "ayah"]}}},
    {"type": "function", "function": {
        "name": "search_hadith",
        "description": "Semantic search over hadith collections (Indonesian translation). Returns addresses and text.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "k": {"type": "integer"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "get_hadith",
        "description": "Fetch one hadith by collection (bukhari, muslim, nasai, abudawud, ibnmajah, tirmidhi, malik) and number.",
        "parameters": {"type": "object", "properties": {
            "collection": {"type": "string"}, "number": {"type": "string"}},
            "required": ["collection", "number"]}}},
    {"type": "function", "function": {
        "name": "find_parallel",
        "description": "Find narrations of the same report in other collections by Arabic-text similarity.",
        "parameters": {"type": "object", "properties": {
            "collection": {"type": "string"}, "number": {"type": "string"}, "k": {"type": "integer"}},
            "required": ["collection", "number"]}}},
]

SYSTEM = (
    "You answer questions about Islam strictly from retrieved sources. Use the tools to find "
    "evidence; you may call them repeatedly. Cite exact addresses: QS. surah:ayah for Quran, "
    "HR. collection no. N for hadith. Never cite an address whose text you have not fetched. "
    "If the tools cannot find evidence, say so explicitly. Answer in the language of the question."
)


def dispatch(name: str, arguments: dict) -> str:
    try:
        if name == "search_quran":
            return search("quran", arguments["query"], int(arguments.get("k", 5)))
        if name == "search_hadith":
            return search("hadith", arguments["query"], int(arguments.get("k", 5)))
        if name == "get_verse":
            return get_verse(arguments["surah"], arguments["ayah"])
        if name == "get_hadith":
            return get_hadith(arguments["collection"], str(arguments["number"]))
        if name == "find_parallel":
            return find_parallel(arguments["collection"], str(arguments["number"]),
                                 int(arguments.get("k", 5)))
        return "unknown tool"
    except Exception as error:  # a tool failure is data for the loop, not a crash
        return f"tool error: {error}"


def run(question_id: str, question: str) -> dict:
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]
    calls, started = [], time.time()
    for _ in range(MAX_ITERATIONS):
        response = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
            json={"model": CHAT_MODEL, "messages": messages, "tools": TOOLS,
                  "tool_choice": "auto", "temperature": 0},
            timeout=120,
        )
        response.raise_for_status()
        message = response.json()["choices"][0]["message"]
        if not message.get("tool_calls"):
            messages.append({"role": "assistant", "content": message.get("content") or ""})
            return {"id": question_id, "answer": message.get("content"),
                    "calls": calls, "seconds": round(time.time() - started, 1)}
        messages.append({"role": "assistant", "content": message.get("content") or None,
                         "tool_calls": message["tool_calls"]})
        for call in message["tool_calls"]:
            name = call["function"]["name"]
            arguments = json.loads(call["function"]["arguments"] or "{}")
            output = dispatch(name, arguments)
            calls.append({"tool": name, "args": arguments, "out": output[:300]})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": output})
    return {"id": question_id, "answer": "(tool budget exhausted)", "calls": calls,
            "seconds": round(time.time() - started, 1)}


def questions() -> dict[str, str]:
    path = os.path.join(ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json")
    fixture = json.load(open(path, encoding="utf-8"))
    rows = fixture["questions"] if isinstance(fixture, dict) else fixture
    return {row["id"]: row["question"] for row in rows}


def main(argv: list[str]) -> int:
    load_dotenv()
    known = questions()
    wanted = argv or list(known)[:1]
    missing = [question_id for question_id in wanted if question_id not in known]
    if missing:
        print(f"unknown question ids: {', '.join(missing)}", file=sys.stderr)
        return 2
    transcript = []
    for question_id in wanted:
        result = run(question_id, known[question_id])
        transcript.append(result)
        print(f"== {question_id} {known[question_id][:70]}")
        for call in result["calls"]:
            print(f"   {call['tool']} {json.dumps(call['args'], ensure_ascii=False)[:110]}")
            print(f"     -> {call['out'][:180]}".replace("\n", " | "))
        print("   answer:", (result["answer"] or "")[:400].replace("\n", " "))
        print("   seconds:", result["seconds"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
