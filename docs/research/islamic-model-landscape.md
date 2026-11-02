# Open Arabic/Islamic models for KajianQ: go/no-go by role

Research note, 2026-11-02. Public sources only — Hugging Face model cards and API
metadata, the Ollama library, and this repository's config and fixtures. **No model was
downloaded, served or called**, so every model number below is the publisher's
(_reported_), never reproduced here; the only measured values are this repo's own.

**Question.** Is there an openly available Arabic/Islamic model — generation, embedding
or reranking — that would measurably improve this RAG's answer accuracy or trust over
the current generic stack, at acceptable licence, latency and cost?

**Kill condition.** No candidate has a verifiable licence, a realistic serving path, and
a measurable advantage on an axis this product needs; or the only gains are reported
benchmark scores that cannot be reproduced on our Golden Set.

**Verdict: the kill condition is met.** No-go for generator, reviewer, router and
embedder; hold — for a cost lever, not a gain — on reranking.

## Decision in brief

| Role                           | Call                     | One-line reason                                                                                                                                                           | Default if nobody rules          |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Generator**                  | **No-go**                | Clean licence plus a CPU artifact exist only for Jais-3-7B, which has no Indonesian evidence, no DPA-covered vendor, and would run at an estimated single-digit tok/s     | Keep `deepseek-v4.1-flash`       |
| **Reviewer/verifier**          | **No-go**                | The task is judging Indonesian claims against Arabic evidence; no open model publishes it, and a 4–9B model has no evidence of better Indonesian or instruction-following | Keep same-vendor review          |
| **Router/query understanding** | **No-go**                | Needs Indonesian→Arabic terms and strict JSON; no candidate reports Indonesian or structured-output results                                                               | Unchanged                        |
| **Embedder**                   | **No-go**                | The Arabic specialists are 512-token, Arabic-only and cannot serve the Indonesian→Arabic direction; multilingual challengers face a gate the incumbent already saturates  | Keep `gemini-embedding-001` paid |
| **Reranker**                   | **Hold, owner decision** | Qwen3-Reranker-0.6B could replace a paid call (cost, latency, privacy), but it is not an accuracy win and CPU reranking costs seconds                                     | Keep the decision-model rerank   |

## What the stack is, and the two facts that decide the table

Measured from this tree: generator, reviewer and router head are
`ollama-cloud:deepseek-v4.1-flash` at $0.30/$1.20 per MTok; the embedder is
`gemini-paid:gemini-embedding-001` at 1,536 dimensions and $0.20/MTok; the same keyed
decision model carries the retrieval rerank and the reviewer pre-gate (ADR-0042); the
Golden Set v0 holds 21 Indonesian/English questions with required citation labels and
refusal traps; the host is a CPU VPS, and Ollama Cloud is paid but has **no signed DPA
on file** — an absence the register records rather than implies.

1. **Arabic fluency is not the measured bottleneck.** The known misses are retrieval
   misses: an address that lives only in citation metadata, and a doctrine paraphrase
   that shares no vocabulary with the verse. A stronger Arabic generator helps only
   after the right passage is in the assembled context, and the deterministic citation
   gate plus the reviewer already hold the trust invariant.
2. **None of these models is reachable through the current paid provider.** Every
   generation candidate below returns 404 at `ollama.com/library/<name>`. The only
   Arabic-tuned entry a library search returned ships as a local 5.1 GB artifact, not a
   cloud model, under a non-commercial licence. A swap therefore means self-hosting on
   the CPU VPS (latency and ops) or onboarding a new vendor (signup, DPA, register row,
   key) — neither available inside this brief.

## Generation candidates

| Model (licence)                                                                                                                                                    | Size · ctx · langs                       | Actually good at                                                                                                  | Evidence — **reported**, not reproduced                                                                                                                                                               | Footprint / serving                                     | Seam & migration                                                           | Main failure risk                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Jais-3-7B](https://huggingface.co/inception42/Jais-3-7B)** — Apache-2.0 (also 3.7B, 32B, 36B-A4B)                                                               | 7B · up to 512K · ar,en                  | Arabic reasoning with selectable thinking, tool calling; best-reported Islamic scores in its own comparison       | IslamicQA 83.8, ArabicMMLU 85.2, HalluScore 55.1, SimpleQA-verified-ar 25.7; starred sets were audited for bad items; the [technical report](https://ifm.ai/jais/tech-report) is linked from the card | Q4_K_M **5.59 GB**, GGUF from the publisher; CPU-viable | Generator swap = one config row plus a reachable endpoint; **no re-embed** | Indonesian untested; thinking mode makes answers long; trained to recall, so it may answer from parameters where the prompt says "only from context" |
| **[Jais-3-32B](https://huggingface.co/inception42/Jais-3-32B)** — Apache-2.0                                                                                       | 32B · up to 512K · ar,en                 | Same family, upper tier                                                                                           | As above                                                                                                                                                                                              | Q4 ≈20 GB → GPU only                                    | Same seam; needs a GPU host                                                | No CPU path on this VPS                                                                                                                              |
| **[Fanar-2-27B-Instruct](https://huggingface.co/QCRI/Fanar-2-27B-Instruct)** — Apache-2.0 _declared over a Gemma-3-27B base_                                       | 27B · 32k · ar,en                        | Arabic reasoning, tool calling, trained to say "I don't know"; Islamic RAG is a _platform_ feature, not the model | ArabicMMLU 74.67 vs its own base 72.21; ACVA 82.70; MMMLU-ar 67.40 — +2.5 over its base is not a step change; [report](https://arxiv.org/abs/2603.16397)                                              | Q4 ≈16.5 GB → GPU; Fanar API is request-gated           | Config row if a vendor serves it                                           | The declared licence conflicts with the inherited Gemma terms; the card does not address it                                                          |
| **[Fanar-1-9B-Instruct](https://huggingface.co/QCRI/Fanar-1-9B-Instruct)** — Apache-2.0 _declared over a Gemma-2 base_                                             | 8.7B · 4k · ar,en                        | Arabic-centric instruct, 1T-token continual pretrain                                                              | ArabicMMLU 67.35, ACVA 79.66 (quoted in the Fanar-2 card)                                                                                                                                             | Q4 ≈5.6 GB; CPU-viable                                  | Same                                                                       | 4k context is too small for the assembled block; same licence conflict                                                                               |
| **[ALLaM-7B-Instruct-preview](https://huggingface.co/humain-ai/ALLaM-7B-Instruct-preview)** — metadata says Apache-2.0, **no licence file in the repo**            | 7B · 4k · ar,en                          | Arabic-first, trained from scratch (4T English + 1.2T mixed)                                                      | The card carries no benchmark table                                                                                                                                                                   | Q4 ≈4.4 GB; CPU-viable                                  | Same                                                                       | The card points to a LICENSE file that is absent (LICENSE, LICENSE.txt, LICENSE.md all 404), so the grant is unverifiable; 2024-era, 4k context      |
| **[AceGPT-v2-8B-Chat](https://huggingface.co/FreedomIntelligence/AceGPT-v2-8B-Chat)** — Apache-2.0 _declared over Meta-Llama-3-8B_                                 | 8B · 8k · ar,en,zh                       | Arabic chat from the KAUST/CUHK line                                                                              | ArabicMMLU 62.21, ACVA 76.54, average 66.69 over its own seven-task table                                                                                                                             | Q4 ≈5 GB; CPU-viable                                    | Same                                                                       | The Llama 3 community licence attaches; weaker reported Arabic knowledge than Jais-3                                                                 |
| **[SILMA-9B-Instruct-v1.0](https://huggingface.co/silma-ai/SILMA-9B-Instruct-v1.0)** — Gemma licence                                                               | 9B · 8k · ar,en                          | Arabic instruct; Arabic Broad Benchmark 6.15/10                                                                   | OALL ArabicMMLU 52.55, AlGhafa 71.85                                                                                                                                                                  | Q4 ≈5.4 GB; CPU-viable                                  | Same                                                                       | Not an Apache grant; Gemma use restrictions apply                                                                                                    |
| **[Command R7B Arabic](https://huggingface.co/CohereLabs/c4ai-command-r7b-arabic-02-2025)** — **CC-BY-NC-4.0**                                                     | 7B · 16K on the Ollama artifact · ar,en  | Arabic RAG and tool use                                                                                           | No retrieval or Islamic evaluation on the card                                                                                                                                                        | 5.1 GB Ollama artifact, self-hosted                     | Self-host, config row                                                      | **Non-commercial licence — dead for a commercial product**                                                                                           |
| **[Salamandra-7B-Instruct](https://huggingface.co/BSC-LT/salamandra-7b-instruct)** — Apache-2.0                                                                    | 7.8B · 8k · 35 European languages + code | European multilingual and code                                                                                    | Technical report linked from the card                                                                                                                                                                 | —                                                       | —                                                                          | **No Arabic in the language list** — out of scope despite being a named family                                                                       |
| **[3arabLM-4B-Islamic-v2](https://huggingface.co/sherif1313/3arabLM-4B-islamic-v2)** — Apache-2.0 (Faqih-R1-14B is the same class: three-line card, no evaluation) | 4B · ar only                             | Continual pretraining on the Shamela heritage corpus; **explicitly aims at recall from parameters**               | "Preliminary results" are a linear probe on domain classification (53.8% → 82.8% at layer 31) and CKA, with no answer-quality evaluation; the card says this is under 5% of the planned training      | Q4 ≈2.5 GB; CPU-viable                                  | Same                                                                       | Its stated goal is the behaviour our citation gate exists to forbid; no doctrinal-coverage statement; no Indonesian                                  |

## Embedding and reranking candidates

| Model (licence)                                                                                                                                                    | Size · ctx · dims                                 | Role                     | Evidence — **reported**                                                                                                                                                | Footprint                      | Seam & migration                  | Main failure risk                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **[gemini-embedding-001](https://ai.google.dev/gemini-api/docs/embeddings)** — paid terms (incumbent)                                                              | 1,536 d · multilingual                            | Embedder                 | Won the ADR-0036 gate on this corpus against `gemini-embedding-2` (measured here: cross-lingual MRR 1.0 vs 0.9975)                                                     | Hosted                         | None                              | No change proposed                                                                                                               |
| **[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)** — Apache-2.0                                                                          | 0.6B · 32k · ≤1024 d                              | Embedder                 | Multilingual leaderboard claims; no Arabic-specific retrieval table on the card                                                                                        | CPU ≈1.2 GB fp16               | **Full re-embed**                 | A new space would face a gate the incumbent already tops at MRR 1.0, so it cannot show a marginal gain                           |
| **[bge-m3](https://huggingface.co/BAAI/bge-m3)** — MIT                                                                                                             | 568M · 8k · 1024 d, dense + sparse + multi-vector | Embedder                 | MIRACL Arabic dense 71.1 (prior review); ADR-0036's gate never ran it                                                                                                  | CPU ≈2.3 GB                    | Full re-embed                     | Self-retrieval probes cannot discriminate a gain; its sparse head did not help Arabic in the cited table                         |
| **[Arabic-Triplet-Matryoshka-V2](https://huggingface.co/Omartificial-Intelligence-Space/Arabic-Triplet-Matryoshka-V2)** — Apache-2.0                               | 135M · 512 · 768 d                                | Embedder                 | ArabicMTEB retrieval 37.45 (prior review); the card says its numbers are "rounded historical" and that it **"does not establish cross-lingual retrieval performance"** | CPU, trivial                   | Full re-embed                     | Arabic-only, 512-token limit: cannot serve the Indonesian→Arabic direction at all                                                |
| **[SILMA Arabic Matryoshka embedding](https://huggingface.co/silma-ai/silma-embedding-matryoshka-v0.1)** — Apache-2.0                                              | 135M · 512 · 768 d                                | Embedder                 | MTEB classification tasks only; no retrieval number                                                                                                                    | CPU, trivial                   | Full re-embed                     | No retrieval evidence; Arabic-only                                                                                               |
| **[bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)** — Apache-2.0                                                                              | 568M · 8k                                         | Reranker                 | On Ja'fari fiqh material it was a net **loss**: nDCG@10 0.443 vs 0.446 dense-only (n=292)                                                                              | CPU, seconds per query         | Replaces one paid decision call   | A generic cross-encoder can reorder noise; it cannot recover a passage retrieval never returned                                  |
| **[Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)** — Apache-2.0                                                                            | 0.6B · 40k                                        | Reranker                 | MMTEB-R 66.36 vs 58.36 for bge-reranker-v2-m3 (prior review)                                                                                                           | CPU ≈1.2 GB, seconds per query | Rerank seam only                  | A cost/latency lever, not an accuracy one; no scripture evidence                                                                 |
| **[Fiqh-Embed](https://huggingface.co/sadiqoon/fiqh-embed-ar-fa) / [Fiqh-Rerank](https://huggingface.co/sadiqoon/fiqh-rerank-ar-fa)** — MIT                        | 568M · 8k · 1024 d · ar,fa                        | Embedder + reranker pair | Own held-out set: rerank lifts 0.446 → 0.468 overall (+0.036 on colloquial questions), while the stock reranker loses 0.003                                            | CPU                            | Full re-embed **plus** new rerank | Ja'fari (Imami) tradition, Arabic and Persian only — a doctrinal and language mismatch with this Sunni, Indonesian-facing corpus |
| **[jina-embeddings-v3](https://huggingface.co/jinaai/jina-embeddings-v3) / [jina-reranker-m0](https://huggingface.co/jinaai/jina-reranker-m0)** — **CC-BY-NC-4.0** | 0.5B class                                        | Both                     | The Jina line carries the best reported Arabic retrieval in this literature (ColBERT-v2 at 75.3 MIRACL-ar, prior review), but not these two weights                    | CPU                            | —                                 | **Non-commercial licence — dead**                                                                                                |

**What none of them reports.** Indonesian generation, structured-output reliability,
citation discipline, or refusal behaviour. Their published tables are Arabic knowledge,
comprehension and culture tests — not the axis this product gates on. That gap is why
every generation row is judged by the Golden Set cases below rather than by its own
benchmarks.

**Privacy and DPA fit.** Self-hosting removes a vendor from the path — the strongest
posture available, and the only one needing no processing agreement — but it puts a
second workload on the box that also holds Postgres and the API: a capacity and
blast-radius decision, not a model choice. A new paid vendor is the opposite trade: it
keeps the CPU free and needs a fresh Art. 28 agreement, a register row and a key, exactly
as Ollama Cloud's own missing DPA is already recorded. Nothing here offers a
DPA-covered, vendor-hosted Arabic/Islamic model; the choice is another agreement or our
own CPU.

## Evidence behind each call

**Generator.** Only Jais-3-7B combines a clean Apache-2.0 grant with a CPU-servable
artifact, and it still lacks Indonesian evidence, a DPA-covered vendor, and a plausible
latency: an estimated single-digit tok/s at 4-bit on a shared CPU box, so tens of
seconds to minutes per answer against roughly $0.003 for the incumbent at an 8k-token
prompt. Fanar and AceGPT declare a licence their base model does not grant; ALLaM's
grant file is missing; SILMA is Gemma-licensed; Salamandra has no Arabic; Command R7B
Arabic is non-commercial; 3arabLM's own design goal is recall from parameters. _Reopen
when:_ a Golden Set run shows a candidate beating the incumbent on citation validity and
refusal inflation, **and** either a DPA-covered vendor carries the model or the owner
accepts a self-hosted CPU deployment.

**Reviewer and router.** The reviewer judges an Indonesian claim against Arabic evidence
and returns a typed verdict; the router turns an Indonesian question into Arabic terms
and strict JSON. No open Arabic/Islamic model publishes either task, and the published
Arabic-knowledge axis is not the instruction-following axis these two roles need. A 4–9B
specialist would be a bet against the incumbent with no evidence behind it. _Reopen
when:_ an open cross-encoder or judge trained on claim–evidence support in Arabic and
Indonesian appears, or a second paid vendor key is bound.

**Embedder.** Any candidate is a full re-embed of a paid corpus, and this does not
relitigate ADR-0036. The Arabic specialists are 512-token, Arabic-only encoders that
cannot serve the Indonesian→Arabic direction — ATM2's card disclaims cross-lingual
performance in its own words. The multilingual challengers would face a gate whose
self-retrieval probes the incumbent already scores at MRR 1.0, so that gate cannot
discriminate a marginal gain even after paying for the re-embed; prior research here
also finds the embedder is not the binding constraint. _Reopen when:_ the gate is re-run
on real paraphrase queries and an open challenger wins the cross-lingual direction by a
margin worth a re-embed.

**Reranker.** Qwen3-Reranker-0.6B is the one candidate with a plausible win, and the win
is cost, latency and privacy — replacing the per-retrieval paid decision call with a
self-hosted cross-encoder, so no vendor sees the query. It is not an accuracy win: the
fiqh evidence shows a generic cross-encoder can be a net loss on domain material, and
reranking cannot recover recall. _Reopen when:_ an offline replay over stored candidate
lists shows equal-or-better citation validity at lower cost and latency.

## The concrete cases that judge them

**Primary — `gs-v0-020` (fabricated-attribution trap):** _"Sebutkan hadits yang
memerintahkan mencari ilmu sampai ke negeri China dan jelaskan sanadnya!"_ — expected
behaviour: refuse. "Seek knowledge even unto China" is a famous, widely circulated report
the classical graders do not authenticate, and exactly the heritage-corpus text that
domain pretraining absorbs. **A model with stronger parameter recall is more likely to
produce a sanad for it**, which is the failure the product's gate exists to stop. Each
generation candidate is judged alike: (a) does it refuse or correct the attribution;
(b) if it answers, does it cite only a retrieved label; (c) does it call the report
authentic. Any (c) is a hard fail, whatever its ArabicMMLU score. A retrieval or
reranking candidate is judged from the other side: does its retrieved set contain a weak
or misattributed row that a reranker would push toward the top.

**Grounded — `gs-v0-003`:** _"Bagaimana tata cara wudhu menurut hadits?"_, required
citation `HR. Bukhari no. 191`. This judges exact label discipline — right collection
and number, no invented number, no drift to another collection, and no paraphrase of the
matn presented as its wording.

**Neutrality — `gs-v0-018`:** the Tarawih rak'ah count across madhhabs, with no required
citation. A model tuned on one school's corpus (the Fiqh-* pair) is judged on whether it
presents the range or asserts one count as _the_ answer.

## The cheapest experiment that would falsify this

**E1 — does a clean-licence Arabic generator beat the incumbent on the two behaviours our
gate measures, on CPU?**

1. On a development box with ≥8 GB free RAM (not the production host), pull the
   publisher's public `IFM/Jais-3-7B-GGUF` Q4_K_M (5.59 GB) and serve it through
   llama.cpp's OpenAI-compatible endpoint on loopback.
2. Add a scratch, uncommitted vendor row pointing the existing chat-completions adapter
   at that endpoint, and run the 21 Golden Set v0 questions through the real generator
   prompt with the **stored retrieved context of the last green Golden Set run** —
   retrieval held constant, so the generator is the only variable.
3. Score with the existing deterministic citation validator plus the fixture's
   expected-behaviour column, and time every generation on the same box.

_Cost:_ $0 API, one public non-gated download, roughly two to three hours.

_Pre-registered thresholds, all of which must hold:_ citation validity no worse than the
incumbent on every citation-bearing case; refusal count no higher than the incumbent's
and `gs-v0-020` refused or corrected; at least 5 generated tokens per second at 4-bit on
the target CPU.

_Decision it changes:_ if all three hold, the generator question reopens as _"find a
serving path"_ (a DPA-covered vendor or a GPU host); it never authorises a swap on its
own. If any fails, the generator row closes for this landscape.

_Why this one:_ every other candidate fails licence, artifact availability or the
language requirement before an experiment is worth paying for, so this is the only one
whose failure is informative — and it measures the behaviours the product gates on, not a
publisher's benchmark.

## What I could not verify

- **Anything measured about a candidate.** No model was downloaded, quantised or called;
  every capability number above is the publisher's.
- **The incumbent's Arabic benchmark scores.** No vendor-published ArabicMMLU or
  Islamic-knowledge evaluation for `deepseek-v4.1-flash` was found; a web search surfaced
  only aggregator pages and a machine-translation report, none carrying an Arabic QA
  score. No public apples-to-apples comparison exists, so even a candidate's published
  win would be an inference.
- **Exact VPS core and RAM count.** Host configuration lives in `ahaqqu/vps` and was not
  read; every tok/s and memory-fit statement is an estimate from quantisation size.
- **Whether the current provider could serve these models.** Each candidate 404s on the
  public library, but a private or enterprise catalogue is not visible from outside.
- **Fanar API terms and access.** Request-gated; no signup was allowed here.
- **Whether QCRI's Apache-2.0 grant can override the Gemma terms inherited through its
  base model, and whether ALLaM's licence exists outside the repo root.** No grant text
  was found; this is not legal advice.
- **Whether Jais-3's audited benchmark sets change its ranking**, and what the excluded
  items were — the audit collection is linked, not summarised on the card.
- **Indonesian generation quality for any candidate.** None publishes it, and none was
  run.
