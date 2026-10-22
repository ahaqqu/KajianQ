# Probe: does a tool-using model reach evidence that single-shot retrieval misses?

**Measured**, 2026-10, local corpus (42,511 rows), harness in
[`research/agentic-probe.py`](../../research/agentic-probe.py). The point of the probe was
to test two mechanisms before proposing a rewrite: (a) can query reformulation reach an
address the single dense pass cannot, and (b) does an address-hypothesis-and-fetch loop
produce verifiable evidence?

## Method

- Eight Golden Set questions were asked verbatim: 006, 007, 008, 012, 016, 017, 001, 003.
- The model (`deepseek-chat`, temperature 0) had five tools over the read-only corpus:
  `search_quran`, `search_hadith` (semantic, over the Indonesian translation track),
  `get_verse(surah, ayah)`, `get_hadith(collection, number)`, `find_parallel(collection, number)`.
- Bounded to at most 10 iterations; each iteration may issue parallel calls.
- The system prompt required answering only from fetched text and citing exact addresses.
- Tokens and cost were **not** metered in this spike; there is no cost claim here.

## What happened

| question               | required               | tool calls | what the answer cited                                                |
| ---------------------- | ---------------------- | ---------: | -------------------------------------------------------------------- |
| 007 (sifat wajib)      | `QS. 42:11`            |         10 | 112:1, 112:4, 2:163, 2:255, 20:8, 23:92, 26:220 … — **not** 42:11    |
| 012 (Ar-Rahman)        | `QS. 1:1`              |         13 | 1:3, 55:1, 7:156 … — the adjacent verse, not 1:1                     |
| 017 (gold garment)     | `HR. Nasai no. 5144`   |          8 | Ibn Majah 3597, Bukhari 375, Bukhari 373, Abu Dawud 4052 …           |
| 016 (zakat)            | `HR. Bukhari no. 1395` |          6 | Bukhari 8, Bukhari 1459, Nasai 2447, Ibn Majah 1788 …                |
| 006 (jamak)            | `HR. Bukhari no. 1108` |         20 | Malik 326/328/331, Muslim 1621/1626/1627, Abu Dawud 1201/1206/1211 … |
| 008 (Quran merit)      | `HR. Bukhari no. 5026` |          6 | Tirmidhi 2910, Bukhari 5028, Bukhari 4937, Tirmidhi 2915             |
| 001 (five prayers)     | —                      |          4 | 4:103, 17:78, 2:43, Bukhari 8, Muslim 11                             |
| 003 (count of prayers) | —                      |          2 | refused: the corpus contains no count                                |

### Finding 1 — reformulation reaches the unreachable verse

For 007 the model rewrote the doctrine question as
_"tidak ada sesuatu pun yang serupa dengan Dia Maha Mendengar Maha Melihat"_. That query
returned **`QS. 42:11` as the third of five results** — the verse the same system ranks
**5,352nd of 42,511** from the user's own wording. The representation did not change; the
query did. This is the mechanism HyDE and query expansion rely on
([ACL 2023](https://aclanthology.org/2023.acl-long.99/)), and it is nearly free.

### Finding 2 — the model can name an address, and a deterministic read confirms it

Every exact row the model obtained came from `get_verse`/`get_hadith`, not from search:
it proposed `QS. 42:11`, `QS. 1:3`, `HR. Bukhari no. 8`, `HR. Ibn Majah no. 3597`, and the
tools confirmed which of those exist. Hypotheses were cheap; the fetch is the evidence.
This is the shape ADR-0058 already uses for a user-written label, generalised to a
model-proposed one — with the rule that a proposed address enters as a _candidate_ and
is cited only if its fetched text supports the sentence.

### Finding 3 — the probe reproduces the contract problem, not the retrieval problem

The answers are well-sourced and every cited row was fetched — but they cite **parallel
evidence**: Ibn Majah 3597 for 017 (a genuine parallel of Nasai 5144), 1:3 for 012 (the
adjacent verse), Malik 326 for 006 (the same report, another chain). Under the current
gate every one of those is a miss, because the gate demands the curator's exact address
among the retrieved chunks. The probe therefore does not show that the gate is wrong; it
shows that **answer quality and address choice are different variables**, and a
tool-using generator will optimise the first. If the product requires the canonical
address, that must be a steering instruction or a unit-level requirement — see
[`answer-attribution.md`](answer-attribution.md).

### Finding 4 — 007 shows the gap between reaching and using

`QS. 42:11` was _in the search results_ and the answer still did not cite it: the model
judged that the corpus does not contain an explicit list of the twenty obligatory
attributes, said so, and supported the doctrine with other verses. That is defensible
reasoning and a wrong Golden Set outcome — again a requirement-shape problem. It also
shows reformulation is necessary but not sufficient; the generator must be told what the
answer has to demonstrate.

### Finding 5 — quote fidelity is not optional

The model quoted verse text it had seen only as a **400-character search snippet**, not
as a fetched row. A deterministic check — the quoted span must be a normalized substring
of the cited chunk — would have forced a fetch, and costs nothing. This is the load-bearing
check argued in [`answer-attribution.md`](answer-attribution.md) §3.

### Finding 6 — the loop is affordable and bounded

Latency 5.3–20.7 s per answer, 2–20 tool calls (median 8). The 20-call case (006) was the
only one that approached the budget, and it still returned a usable answer. A cap of 8–10
iterations with at most 2 parallel calls per iteration looks sufficient for this corpus;
cost must be metered before this is proposed for production.

## What the probe supports, and what it does not

**Supports:** reformulation + verified fetch is a real, cheap mechanism for reaching
evidence the dense pass cannot; a bounded tool loop is practical; a deterministic quote
check is necessary.

**Does not support:** that an agentic loop alone fixes the Golden Set. It changes _which_
valid evidence the answer uses, so it cannot satisfy an exact-address requirement without
a unit contract or explicit steering. It also does not measure cost, because the spike
did not meter tokens — the next iteration must.

## Reproducing

The harness reads `GEMINI_API_KEY` (query embeddings), `DEEPSEEK_API_KEY` (generation),
`PGPASSWORD` (read-only Postgres), and prints a transcript per question. It is a spike,
not product code: no trace, no cost ledger, no retries. Any production adoption must move
it behind the existing pipeline seams and trace every tool call.
