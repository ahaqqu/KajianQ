#!/usr/bin/env python3
"""Experiment: does chunk-specific context make a needed verse retrievable?

Implements the falsification test in docs/research/retrieval-evidence.md §10, on the
Quran subset (6,236 rows):

  V0  today's embedded text (the stored Indonesian-translation vector)
  V1  generic label: address + surah name + translation
  V2  contextual label: address + surah name + a 1-2 sentence Indonesian context line
      generated from the verse, written in the vocabulary a lay question would use

It reports the exact rank of each required verse for its own Golden Set question under
each variant, and the top-10 hit count across the nine questions whose requirement is a
Quran verse.

Scratch state lives in the `kq_research` database and /tmp; the corpus database is only
read. Stages are resumable:

    python3 research/contextual-header-experiment.py headers
    python3 research/contextual-header-experiment.py embed
    python3 research/contextual-header-experiment.py measure

Environment: GEMINI_API_KEY (embeddings), DEEPSEEK_API_KEY (context lines), PGPASSWORD.
See docs/research/agentic-probe.md for the environment conventions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = "/tmp/kq-quran-headers.jsonl"
HEADERS = {}
LOCK = threading.Lock()
WORKERS = 10
BATCH = 64
RESEARCH_DB = "kq_research"
CORPUS_DB = "kajianq"

HEADER_PROMPT = (
    "Anda menyiapkan indeks pencarian untuk terjemahan Al-Qur'an. "
    "Alamat ayat: QS. {surah}:{ayah}.\nTeks terjemahan: {body}\n\n"
    "Tulis 1-2 kalimat (maksimal 35 kata) dalam bahasa Indonesia yang menjelaskan ajaran "
    "atau tema ayat ini dan istilah yang mungkin dipakai orang awam ketika menanyakannya. "
    "Jangan mengutip ayat, jangan menyebut nomor ayat, jangan memakai kata 'ayat ini'. "
    "Output hanya kalimatnya."
)


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


def psql(database: str, query: str) -> list[list[str]]:
    command = ["psql", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", database,
               "-tA", "-F", "\t", "-c", query]
    completed = subprocess.run(command, capture_output=True, text=True,
                               env={**os.environ, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-500:])
    return [line.split("\t") for line in completed.stdout.splitlines()
            if line and line != "SET" and not line.startswith("COPY ")]


def psql_script(database: str, script: str) -> None:
    """Run several statements in one session, so a temp table and its COPY share it."""
    completed = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", database, "-q"],
        input=script, capture_output=True, text=True,
        env={**os.environ, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-500:])


def quran_rows() -> list[dict]:
    rows = psql(RESEARCH_DB, "select id, surah, ayah, body from quran order by surah, ayah")
    return [{"id": r[0], "surah": int(r[1]), "ayah": int(r[2]), "body": r[3]} for r in rows]


def surah_names() -> dict[int, str]:
    path = "/tmp/surah-names.json"
    if not os.path.exists(path):
        raise SystemExit("missing /tmp/surah-names.json: export SURAH_NAMES from "
                         "packages/kajianq-domain/src/surah-names.ts first")
    return {row["number"]: row["name"] for row in json.load(open(path, encoding="utf-8"))}


def generate_header(row: dict) -> None:
    prompt = HEADER_PROMPT.format(surah=row["surah"], ayah=row["ayah"], body=row["body"][:900])
    for attempt in range(4):
        try:
            response = requests.post(
                "https://api.deepseek.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
                json={"model": "deepseek-chat", "temperature": 0.2,
                      "messages": [{"role": "user", "content": prompt}]},
                timeout=90,
            )
            response.raise_for_status()
            line = response.json()["choices"][0]["message"]["content"].strip().replace("\n", " ")
            with LOCK, open(CACHE, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"id": row["id"], "header": line}, ensure_ascii=False) + "\n")
            HEADERS[row["id"]] = line
            return
        except Exception as error:
            if attempt == 3:
                print(f"header failed for {row['id']}: {error}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def stage_headers(rows: list[dict]) -> None:
    if os.path.exists(CACHE):
        for line in open(CACHE, encoding="utf-8"):
            record = json.loads(line)
            HEADERS[record["id"]] = record["header"]
    pending = [row for row in rows if row["id"] not in HEADERS]
    print(f"headers: {len(HEADERS)} cached, {len(pending)} to generate")
    if not pending:
        return
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for index, _ in enumerate(pool.map(generate_header, pending), 1):
            if index % 250 == 0:
                print(f"  {index}/{len(pending)}")


def embed(texts: list[str]) -> list[list[float]]:
    for attempt in range(6):
        try:
            response = requests.post(
                "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
                headers={"Authorization": f"Bearer {os.environ['GEMINI_API_KEY']}"},
                json={"model": "gemini-embedding-001", "input": texts, "dimensions": 1536},
                timeout=180,
            )
            if response.status_code == 429:
                raise RuntimeError("rate limited")
            response.raise_for_status()
            return [item["embedding"] for item in response.json()["data"]]
        except Exception as error:
            if attempt == 5:
                raise
            wait = 10 * (attempt + 1)
            print(f"  embed retry in {wait}s: {error}", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def vector_text(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def stage_embed(rows: list[dict], names: dict[int, str]) -> None:
    for variant in ("v1", "v2"):
        existing = psql(RESEARCH_DB, f"select count(*) from variants where variant = '{variant}'")[0][0]
        if int(existing):
            print(f"{variant}: {existing} rows already embedded, skipping")
            continue
        texts, addresses = [], []
        for row in rows:
            address = f"{row['surah']}:{row['ayah']}"
            prefix = f"QS. {address} (Surah {names[row['surah']]})."
            header = HEADERS.get(row["id"], "")
            if variant == "v2":
                texts.append(f"{prefix} {header} {row['body']}".strip())
            else:
                texts.append(f"{prefix} {row['body']}".strip())
            addresses.append((row["id"], address, texts[-1]))
        print(f"{variant}: embedding {len(texts)} texts")
        rows_out = []
        for start in range(0, len(texts), BATCH):
            chunk = texts[start:start + BATCH]
            vectors = embed(chunk)
            for offset, vector in enumerate(vectors):
                doc_id, address, body = addresses[start + offset]
                rows_out.append((doc_id, variant, address, body.replace("\t", " "), vector_text(vector)))
            if start % (BATCH * 10) == 0:
                print(f"  {start + len(chunk)}/{len(texts)}")
        path = f"/tmp/{variant}.tsv"
        with open(path, "w", encoding="utf-8") as handle:
            for row in rows_out:
                handle.write("\t".join(row) + "\n")
        psql_script(RESEARCH_DB, (
            f"create temp table load_{variant} (doc_id uuid, variant text, address text, "
            f"body text, embedding vector(1536));\n"
            f"\\copy load_{variant} from '{path}'\n"
            f"insert into variants select * from load_{variant};\n"))
        print(f"{variant}: inserted")


def stage_measure() -> None:
    fixture = json.load(open(os.path.join(
        ROOT, "packages/kajianq-domain/fixtures/golden-set-v0.json"), encoding="utf-8"))
    questions = fixture["questions"] if isinstance(fixture, dict) else fixture
    targets = []
    for question in questions:
        for citation in question.get("requiredCitations", []):
            if citation.startswith("QS."):
                address = citation.split("QS.")[1].strip()
                targets.append({"id": question["id"], "address": address,
                                "question": question["question"]})
    print(f"measure: {len(targets)} questions with a Quran requirement")
    results = []
    for target in targets:
        vector = vector_text(embed([target["question"]])[0])
        row = {"id": target["id"], "address": target["address"], "question": target["question"]}
        row["v0"] = int(psql(RESEARCH_DB, f"""
            select rank from (select (surah || ':' || ayah) as address,
                row_number() over (order by v0 <=> '{vector}'::vector) as rank from quran) t
            where address = '{target['address']}'""")[0][0])
        for variant in ("v1", "v2"):
            row[variant] = int(psql(RESEARCH_DB, f"""
                select rank from (select address,
                    row_number() over (order by embedding <=> '{vector}'::vector) as rank
                    from variants where variant = '{variant}') t
                where address = '{target['address']}'""")[0][0])
        results.append(row)
        print(f"  {row['id']} {row['address']}: v0 #{row['v0']}, v1 #{row['v1']}, v2 #{row['v2']}")
    top10 = {variant: sum(1 for row in results if row[variant] <= 10) for variant in ("v0", "v1", "v2")}
    print(f"top-10 hits of {len(results)}: {top10}")
    json.dump({"rows": results, "top10": top10}, open("/tmp/kq-contextual-results.json", "w"),
              ensure_ascii=False, indent=1)


def main(argv: list[str]) -> int:
    load_dotenv()
    stage = argv[0] if argv else "all"
    rows = quran_rows()
    names = surah_names()
    if stage in ("headers", "all"):
        stage_headers(rows)
    if stage in ("embed", "all"):
        stage_embed(rows, names)
    if stage in ("measure", "all"):
        stage_measure()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
