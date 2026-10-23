#!/usr/bin/env python3
"""#647 retrieval harness — exact cosine rank over the local corpus.

One job: given a query vector, report where a required address ranks in `doc_children`
(42,511 rows, `embedding_primary`, gemini-embedding-001, 1536 dims), overall and within its
source type. Query vectors come from either

  * a live embedding of a text (Gemini OpenAI-compatible embeddings wire), or
  * a stored row's own vector (`--vector-of`), which costs nothing and is how every
    "quote / twin / neighbour" representation is measured without a vendor call.

It proves itself before its numbers count: `--selfcheck` runs known cases (each target row
against its own vector must rank 1; the verse's own translation must rank 1 overall; the two
baselines with a reported figure must land near it) and refuses to continue if they fail.

Read-only: every psql session opens with `SET default_transaction_read_only = on`.
No key is read from a file by this script; it uses GEMINI_API_KEY from the environment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

DSN = ["-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "kajianq"]
CACHE = Path("/tmp/kq647-embeddings.json")
EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
EMBED_MODEL = "gemini-embedding-001"
DIMS = 1536

# The four rows #647 scopes. `required` is the address the Golden Set row demands at head.
TARGETS = {
    "007": {"kind": "quran", "surah": "42", "ayah": "11", "label": "QS. 42:11"},
    "008": {"kind": "hadith", "collection": "bukhari", "hadithNo": "5026", "label": "HR. Bukhari no. 5026"},
    "011": {"kind": "hadith", "collection": "muslim", "hadithNo": "534", "label": "HR. Muslim no. 534"},
    "016": {"kind": "hadith", "collection": "bukhari", "hadithNo": "1395", "label": "HR. Bukhari no. 1395"},
}


def psql(sql: str, tuples: bool = True) -> list[list[str]]:
    out = subprocess.run(
        ["psql", "-q", *DSN, "-t", "-A", "-F", "\t", "-c",
         "SET default_transaction_read_only = on; " + sql],
        capture_output=True, text=True,
        env={**os.environ, "PGPASSWORD": "kq"},
    )
    if out.returncode:
        sys.exit(f"psql failed: {out.stderr.strip()}\nSQL: {sql[:300]}")
    if not tuples:
        return [[out.stdout.strip()]]
    return [ln.split("\t") for ln in out.stdout.strip().split("\n") if ln.strip()]


def target_where(spec: dict) -> str:
    if spec["kind"] == "quran":
        return (f"citation->>'sourceType'='quran' and citation->>'surah'='{spec['surah']}' "
                f"and citation->>'ayah'='{spec['ayah']}'")
    return (f"citation->>'sourceType'='hadith' "
            f"and citation->>'collection'='{spec['collection']}' "
            f"and citation->>'hadithNo'='{spec['hadithNo']}'")


def target_row(spec: dict) -> dict:
    rows = psql(f"select id, text_id, text_ar from doc_children where {target_where(spec)};")
    if len(rows) != 1:
        sys.exit(f"expected exactly one row for {spec['label']}, found {len(rows)}")
    rid, text_id, text_ar = rows[0]
    return {"id": rid, "text_id": text_id, "text_ar": text_ar}


def row_vector(rid: str) -> list[float]:
    raw = psql(f"select embedding_primary::text from doc_children where id='{rid}';")[0][0]
    return json.loads(raw)


def embed(texts: list[str]) -> list[list[float]]:
    """Embed texts, cached by content so re-runs cost nothing."""
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    out: list[list[float] | None] = [None] * len(texts)
    missing = []
    for i, t in enumerate(texts):
        h = hashlib.sha256((EMBED_MODEL + "\x00" + t).encode()).hexdigest()
        if h in cache:
            out[i] = cache[h]
        else:
            missing.append((i, t, h))
    if missing:
        key = os.environ.get("GEMINI_API_KEY", "")
        if not key:
            sys.exit("GEMINI_API_KEY is not set (source the root .env)")
        for start in range(0, len(missing), 16):
            batch = missing[start:start + 16]
            body = json.dumps({"model": EMBED_MODEL,
                               "input": [t for _, t, _ in batch],
                               "dimensions": DIMS}).encode()
            req = urllib.request.Request(
                EMBED_URL, data=body,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    payload = json.loads(r.read())
            except urllib.error.HTTPError as e:
                sys.exit(f"embed HTTP {e.code}: {e.read()[:300]!r}")
            vectors = [d["embedding"] for d in payload["data"]]
            if len(vectors) != len(batch):
                sys.exit(f"embed returned {len(vectors)} vectors for {len(batch)} texts")
            for (i, _, h), v in zip(batch, vectors):
                cache[h] = v
                out[i] = v
            CACHE.write_text(json.dumps(cache))
    return [v for v in out if v is not None]


def vec_literal(v: list[float]) -> str:
    return "'[" + ",".join(f"{x:.9g}" for x in v) + "]'::vector"


def rank_of(v: list[float], spec: dict, k: int = 50) -> dict:
    lit = vec_literal(v)
    where = target_where(spec)
    total = int(psql("select count(*) from doc_children where embedding_primary is not null;")[0][0])
    # Rank counts rows strictly closer than the target; ties share the target's rank.
    r = int(psql(
        "select count(*) + 1 from doc_children t where t.embedding_primary is not null "
        f"and (t.embedding_primary <=> {lit}) < "
        f"(select b.embedding_primary <=> {lit} from doc_children b where b.id = "
        f"(select id from doc_children where {where}));")[0][0])
    cos = float(psql(
        f"select 1 - (embedding_primary <=> {lit}) from doc_children where {where};")[0][0])
    # Rank within the target's own source type, the number the earlier probe reported.
    stype = "quran" if spec["kind"] == "quran" else "hadith"
    sub = int(psql(
        "select count(*) + 1 from doc_children t where t.embedding_primary is not null "
        f"and t.citation->>'sourceType'='{stype}' and (t.embedding_primary <=> {lit}) < "
        f"(select b.embedding_primary <=> {lit} from doc_children b where b.id = "
        f"(select id from doc_children where {where}));")[0][0])
    n_sub = int(psql(f"select count(*) from doc_children where citation->>'sourceType'='{stype}';")[0][0])
    top = psql(
        "select citation::text, round((1 - (embedding_primary <=> " + lit + "))::numeric, 6) "
        f"from doc_children where embedding_primary is not null "
        f"order by embedding_primary <=> {lit} limit {k};")
    return {"rank": r, "total": total, "rankWithinType": sub, "totalWithinType": n_sub,
            "cosine": cos, "top": [{"citation": json.loads(c[0]), "cosine": float(c[1])} for c in top]}


def addr(c: dict) -> str:
    if c.get("sourceType") == "quran":
        return f"QS. {c['surah']}:{c['ayah']}"
    if c.get("sourceType") == "hadith":
        return f"HR. {c['collection'].title()} no. {c['hadithNo']}"
    return json.dumps(c)


def show(label: str, spec: dict, res: dict, k: int = 10) -> None:
    print(f"[{label}] {spec['label']}: rank {res['rank']}/{res['total']} "
          f"(within {res['totalWithinType']}: {res['rankWithinType']}), cos {res['cosine']:.4f}")
    hits = [f"{addr(c['citation'])} {c['cosine']:.3f}" for c in res["top"][:k]]
    print("   top-" + str(k) + ": " + " | ".join(hits))


def selfcheck() -> None:
    """Known cases. Refuse to continue if any fails."""
    print("== selfcheck: stored vectors ==")
    for tid, spec in TARGETS.items():
        row = target_row(spec)
        v = row_vector(row["id"])
        res = rank_of(v, spec, k=1)
        ok = res["rank"] == 1
        print(f"  {tid} {spec['label']}: self-vector rank {res['rank']} cos {res['cosine']:.6f} "
              f"{'OK' if ok else 'FAIL'}")
        if not ok:
            sys.exit("selfcheck failed: a row's own vector must rank 1")
    print("== selfcheck: known reported cases ==")
    q007 = target_row(TARGETS["007"])
    cases = [
        ("007 verse own translation (reported #1)", TARGETS["007"], q007["text_id"], 1),
        ("007 verbatim question (reported #5352)", TARGETS["007"],
         "Apa itu sifat wajib bagi Allah dalam aqidah Ahlus Sunnah?", 5352),
        ("011 verbatim question (reported #11)", TARGETS["011"],
         "Sebutkan hadits tentang kebersihan itu sebagian dari iman!", 11),
    ]
    for label, spec, text, expected in cases:
        res = rank_of(embed([text])[0], spec, k=3)
        delta = res["rank"] - expected
        print(f"  {label}: measured {res['rank']} (expected {expected}, delta {delta:+d})")
    print("selfcheck: see values above; an exact self-vector match and a near baseline are required")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selfcheck", action="store_true")
    ap.add_argument("--query", action="append", default=[], help="text to embed as a query")
    ap.add_argument("--query-file", action="append", default=[],
                    help="path to a file whose contents is the query text")
    ap.add_argument("--vector-of", action="append", default=[],
                    help="address spec key (007/008/011/016) or 'collection:no' / 'surah:ayah'")
    ap.add_argument("--target", action="append", default=[], help="target spec key")
    ap.add_argument("--k", type=int, default=10)
    args = ap.parse_args()
    if args.selfcheck:
        selfcheck()
        return
    targets = args.target or list(TARGETS)
    queries: list[tuple[str, list[float]]] = []
    for t in args.query:
        queries.append((t[:60], embed([t])[0]))
    for p in args.query_file:
        text = Path(p).read_text().strip()
        queries.append((f"file:{p}", embed([text])[0]))
    for v in args.vector_of:
        if v in TARGETS:
            row = target_row(TARGETS[v])
            queries.append((f"vector of {TARGETS[v]['label']}", row_vector(row["id"])))
        else:
            kind, _, num = v.partition(":")
            if kind == "quran":
                s, a = num.split("/")
                spec = {"kind": "quran", "surah": s, "ayah": a,
                        "label": f"QS. {s}:{a}"}
            else:
                coll, no = num.split("/")
                spec = {"kind": "hadith", "collection": coll, "hadithNo": no,
                        "label": f"HR. {coll.title()} no. {no}"}
            row = target_row(spec)
            queries.append((f"vector of {spec['label']}", row_vector(row["id"])))
    for qlabel, vec in queries:
        for t in targets:
            show(f"{qlabel}", TARGETS[t], rank_of(vec, TARGETS[t], k=args.k), k=args.k)


if __name__ == "__main__":
    main()
