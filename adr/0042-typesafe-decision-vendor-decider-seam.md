# ADR-0042: TypeSafe AI decision vendor — `Decider` seam, systemone adapter, and the multilingual gate bench

## Status

Accepted (2026-09-19). Amends ADR-0009 (vendor allowlist: the `typesafe`
vendor enters the catalog priced and capped, bench-only). The gate itself is
**pending its run**: the `decision-candidates` role is wired, the fixture is
authored, and `bun run eval:decision-bench` is the operator-driven gate —
no pipeline stage may consume the vendor until the run's numbers clear the
floors recorded here.

## Context

The owner holds an API key for TypeSafe AI's "System One" endpoint — a
decision model ("Jev", pinned `jev-1.13.0`) that answers typed structured
questions (Choice / Score / Noul) over a state instead of generating text.
It is not a chat model and not an embedding model, so it cannot stand in a
`Provider` fallback chain; it is priced on input tokens only (42 micro-USD
per MTok, output free), which makes it a candidate for the cheap-judgment
stages of a RAG pipeline:

- **relevance screening** of retrieved passages before assembly (shrinks the
  generator prompt),
- **reranking** the fused candidate list,
- **fuzzy citation verification** ahead of the paid cross-vendor reviewer,
- feedback triage and eval-run scoring.

Every one of those uses touches the product's trust surface (what evidence
reaches the generator, whether a citation passes), and the corpus is Arabic
(canonical) + Indonesian (fallback) — while the vendor's published evidence
is English-domain. The project's standing rule (ADR-0036 precedent: the
embedding default was decided by a benchmark, not asserted) therefore
applies: **the vendor enters the catalog, but adoption in any pipeline
stage is gated on a multilingual benchmark run.**

## Decision

1. **New seam, not a `Provider` method.** `Decider` lives in
   `packages/rag-core/src/decider.ts` beside `Provider` (ADR-0022's seam
   home): `decide(spec) → Effect<DecisionResult, ProviderError>` with
   `DecisionSpec = { state, questions }` — question shapes (Noul/Choice/
   Score) are protocol data, engine-agnostic. Failures ride `ProviderError`
   so retry policy and the attempt-cost discipline stay uniform.

2. **Vendor-name-free adapter.** `systemone-adapter.ts` in
   `packages/infra/src/providers/` speaks the vendor's REST wire
   (`POST {baseUrl}/systemone`, Bearer auth, answers keyed by question id),
   driven entirely by `models.json` config. Cost is metered from the
   response's `usage.input_tokens` (ceil'd, `estimated` flagged when the
   vendor reports none — the ADR-0022 rule); a vendor-reaching failure
   carries its estimated input spend on `attemptCosts`. 429 and 529
   (overloaded) map to the retryable `rate_limited`/`server` kinds.

3. **Allowlist amendment (ADR-0009).** The `typesafe` vendor enters
   `models.json`: pinned model, input-only price, `freeTier: false`,
   `personalDataAllowed: true`. The bench-only `decision-candidates` role
   holds it — mirroring `embedder-candidates` — and is **not** referenced
   by any serving role. Adding a serving role (e.g. a reviewer pre-gate) is
   a future PR that must cite this ADR's gate result.

4. **The multilingual gate bench.** `bun run eval:decision-bench`
   (`packages/eval/scripts/decision-bench.mjs` + the `@app/eval`
   `decision-bench` module, contracts in `@app/contracts`
   `decision-bench.ts`) runs every keyed `decision-candidates` entry over a
   versioned fixture (`packages/kajianq-domain/fixtures/decision-bench-v0.json`):
   - **relevance** (Noul: does the passage answer the query?),
   - **rerank** (Choice: which candidate best answers the query?),
   - **citation** (Noul: does the passage support the claim as stated?),
     in Arabic, Indonesian, and English — 21 cases. Passages are verbatim
     from commit-safe sources (Bukhari hadith 1–2 and Abu Dawud 1 ara/ind/eng
     via fawazahmed0/hadith-api, The Unlicense; Quran Arabic ayah excerpts
     from the Tanzil Uthmani edition, verbatim distribution permitted with
     attribution). Indonesian/English Quran _translation_ wording is
     deliberately excluded — the Kemenag translation's licensing is gated by
     prerequisite #2 — so the Indonesian cells ride the Unlicense hadith
     edition instead. The gate therefore measures the model against the
     product's actual evidence languages, not sanitized examples, without
     committing gated text.

   **Floors:** overall accuracy ≥ 0.85 **and** every language ≥ 0.75 (a
   language with fewer than 3 scored cases is reported but does not count
   for or against the floor — a single-case language would make the floor a
   coin flip). The CLI exits non-zero when no keyed candidate passes, so a
   failed gate cannot be read as a passed one; with `TYPESAFE_API_KEY`
   absent it reports NOT RUN and exits 0 (CI has no key, mirroring
   provider-smoke).

   The fixture stays `v0-draft` until the owner signs the ground truths
   off; the prompt templates live in the domain pack
   (`decision-bench-prompts.ts`) — the wording is deliberately
   language-neutral, so the gate measures cross-lingual judgment of the
   _content_, not of translated instructions.

5. **Operator-driven, cost-isolated** (ADR-0037 pattern): the bench is run
   by hand, never in CI's spend path; `EVAL_BUDGET_MICRO_USD` hard-caps the
   run (estimated full-run cost: ~21 requests × <2k tokens ≈ well under
   $0.01 at the pinned price). The JSON report lands next to the fixture
   (`decision-bench-results.json`) and is citable — the adoption decision
   cites the report, exactly as ADR-0036's posture cites its bench file.

## Consequences

- The engine gained its first non-chat protocol: `provider-config.ts`
  accepts `protocol: "systemone"` and the `decide` capability — the schema
  is still a closed list, so a new protocol remains a reviewed change, not
  an open string.
- The boundary gate's vendor rule is unaffected: `typesafe` appears only in
  `models.json`; the adapter and tests use synthetic vendor names.
- If the gate fails, the seam and adapter remain useful dead code for any
  future decision vendor — one config row swaps the endpoint; the fixture
  and scorers are vendor-free and reusable.
- If the gate passes, the **next PR** is the adoption proposal: which
  stage (reviewer pre-gate first — it fronts the most expensive per-query
  LLM spend), wired through a config-gated path so serving can be turned
  off without a deploy. That PR must cite the bench report and add its
  cost-per-query trace events (traceability rule 2).

## Alternatives considered

- **Route Jev through the existing `Provider` seam as a "generate" model
  with JSON output.** Rejected: it would force a structured-answer protocol
  through a text-generation interface, hide the question typing in prompt
  strings, and let Jev land in a chat fallback chain where it cannot answer.
- **Adopt directly for the reviewer pre-gate and measure in staging.**
  Rejected: that inverts the ADR-0036 precedent — an unmeasured vendor
  would touch the trust surface (citation verification) before any
  multilingual evidence existed, and a staging smoke would not cover
  Arabic/Indonesian judgment quality.
- **Skip the vendor entirely (English-only evidence).** Rejected by the
  owner: the price profile (input-only, ~$0.042/MTok) is favorable enough
  to justify one bench run's effort; the gate keeps the risk bounded.
