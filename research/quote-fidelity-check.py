#!/usr/bin/env python3
"""Prototype: the deterministic quote-fidelity check.

The check turns "the model says it used this passage" into "these characters are in this
passage": every quoted span must be a normalized substring of the chunk it cites. This
harness measures the check against positive cases (verbatim, elided, diacritics-stripped)
and negative ones (paraphrase, a quote lifted from another chunk).

    python3 research/quote-fidelity-check.py

Environment: PGPASSWORD. Reads the corpus read-only; writes nothing.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

ENV = {**os.environ, "PATH": "/usr/bin:/bin"}
DIACRITICS = re.compile(r"[\u064B-\u0652\u0670\u06D6-\u06ED\u0640]")
FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})
ELLIPSIS = re.compile(r"\.\.\.|…")


def sql(query: str) -> list[list[str]]:
    completed = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "kajianq",
         "-tA", "-F", "\t", "-c", "SET default_transaction_read_only = on; " + query],
        capture_output=True, text=True, env=ENV)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-300:])
    return [line.split("\t") for line in completed.stdout.splitlines()
            if line and line != "SET"]


def normalise(text: str) -> str:
    """Fold what must not matter: diacritics, alef/ya/ta-marbuta variants, punctuation, case."""
    text = DIACRITICS.sub("", text).translate(FOLD).lower()
    text = re.sub(r"[^\w\u0600-\u06FF ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def quote_is_faithful(quote: str, chunk: str) -> bool:
    """True when every fragment of the quote appears in order inside the chunk.

    The split must happen before normalisation: normalising first erases the ellipsis and
    turns an elided quote into one contiguous string that no chunk contains.
    """
    chunk_norm = normalise(chunk)
    if not normalise(quote):
        return False
    if normalise(quote) in chunk_norm:
        return True
    fragments = [fragment for fragment in ELLIPSIS.split(quote) if normalise(fragment)]
    if len(fragments) < 2:
        return False
    position = 0
    for fragment in fragments:
        piece = normalise(fragment)
        found = chunk_norm.find(piece, position)
        if found < 0:
            return False
        position = found + len(piece)
    return True


def cases() -> list[tuple[str, str, str, bool]]:
    rows = []
    for collection, number in (("bukhari", "1108"), ("bukhari", "1395"), ("nasai", "5144")):
        row = sql(f"select text_id, text_ar from doc_children where citation->>'collection' = "
                  f"'{collection}' and citation->>'hadithNo' = '{number}' limit 1")
        rows.append((f"{collection} {number}", row[0][0], row[0][1]))
    for surah, ayah in ((42, 11), (1, 1), (2, 255)):
        row = sql(f"select text_id, text_ar from doc_children where metadata->>'surah' = "
                  f"'{surah}' and metadata->>'ayah' = '{ayah}' limit 1")
        rows.append((f"QS {surah}:{ayah}", row[0][0], row[0][1]))

    out = []
    for index, (name, translation, arabic) in enumerate(rows):
        words = translation.split()
        other = rows[0 if index else 1][1].split()
        positive = {
            "verbatim": " ".join(words[2:14]),
            "elided": " ".join(words[2:8]) + " ... " + " ".join(words[10:14]),
        }
        negative = {
            "paraphrase": " ".join(reversed(words[2:14])),
            "wrong-chunk": " ".join(other[2:14]),
        }
        for label, quote in positive.items():
            out.append((name, label, quote, translation))
        for label, quote in negative.items():
            out.append((name, label, quote, translation))
        arabic_words = arabic.split()
        if len(arabic_words) > 8:
            out.append((name, "arabic-stripped",
                        DIACRITICS.sub("", " ".join(arabic_words[2:12])), arabic))
    return out


def main() -> int:
    matrix = cases()
    results = [(name, label, quote_is_faithful(quote, chunk)) for name, label, quote, chunk in matrix]
    expected = {"verbatim": True, "elided": True, "arabic-stripped": True,
                "paraphrase": False, "wrong-chunk": False}
    print(f"{'source':14} {'case':16} {'accepted':9} {'expected':9} ok")
    failures = 0
    for name, label, accepted in results:
        want = expected[label]
        ok = accepted == want
        failures += 0 if ok else 1
        print(f"{name:14} {label:16} {str(accepted):9} {str(want):9} {'yes' if ok else 'NO'}")
    print(f"\n{len(results)} cases, {failures} mismatches")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
