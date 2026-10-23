#!/usr/bin/env python3
"""Shared paid-call helper for the #647 probes: one DeepSeek call, usage measured.

`reasoning_effort: none` is required on this model — with reasoning left on it spends the whole
`max_tokens` budget in `reasoning_tokens` and returns empty content (measured in E2's dry run).
Spend is computed from the vendor's own `usage` block at the configured peak price
(`packages/infra/src/providers/models.json`: $0.30/$1.20 per MTok), so it is measured tokens x
recorded price, not an estimate.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

MODEL = "deepseek-v4-flash"
URL = "https://api.deepseek.com/v1/chat/completions"
PRICE_IN = 0.30 / 1_000_000
PRICE_OUT = 1.20 / 1_000_000

SPEND = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "usd": 0.0}


def llm(prompt: str, max_tokens: int = 1500) -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        sys.exit("DEEPSEEK_API_KEY is not set (source the root .env)")
    body = json.dumps({"model": MODEL,
                       "messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": max_tokens,
                       "reasoning_effort": "none"}).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    u = d.get("usage") or {}
    pt, ct = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
    SPEND["calls"] += 1
    SPEND["prompt_tokens"] += pt
    SPEND["completion_tokens"] += ct
    SPEND["usd"] += pt * PRICE_IN + ct * PRICE_OUT
    return (d["choices"][0]["message"]["content"] or "").strip()


def spend_line() -> str:
    return (f"spend: {SPEND['calls']} LLM calls, {SPEND['prompt_tokens']} prompt + "
            f"{SPEND['completion_tokens']} completion tokens = ${SPEND['usd']:.6f} at the "
            f"recorded peak price")
