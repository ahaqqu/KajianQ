# ADR-0042: TypeSafe AI decision vendor — `Decider` seam, systemone adapter, and the multilingual gate bench

## Status

Accepted (2026-09-19). Amends ADR-0009 (vendor allowlist: the `typesafe`
vendor enters the catalog priced and capped, bench-only). The gate **ran
the same day and passed**: `jev-1.13.0` scored 21/21 overall and per-language
(ar/id/en × 7/7) — relevance 12/12, rerank 3/3, citation 6/6 — for a total of
21 micro-USD (report: the domain pack's
`fixtures/decision-bench-results.json`, committed with this ADR). The gate
remains operator-driven and re-runnable; the fixture is `v0-draft` (owner
sign-off pending), so serving adoption (the reviewer pre-gate, ticketed
separately) rides on fail-open design, not on this smoke-grade score.
**Amended 2026-09-27 (ticket #168): the serving adoption landed always-on
wherever the key is bound, with no dedicated kill switch — see the
[Amendment](#amendment-2026-09-27-serving-adoption-always-on-where-the-key-is-bound-no-kill-switch)
section, which supersedes this ADR's "config-gated path" consequence.**

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
   failed gate cannot be read as a passed one; with `JEV_API_KEY`
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
  **(Superseded 2026-09-27, ticket #168: the adoption landed, but the
  "config-gated path" half does not — the pre-gate is always active wherever
  the decision vendor's key is bound, with no dedicated kill switch. See the
  Amendment below; the rest of this bullet held: the adoption PR cites the
  bench report and adds the trace events.)**

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

## Amendment (2026-09-27): serving adoption always-on where the key is bound, no kill switch

**Owner decision (2026-09-19, recorded in the #167 spec):** the pre-gate is
active whenever the decision vendor's API key is bound — exactly how every
other provider role in `models.json` behaves (key absent = candidate not
wired). There is **no dedicated enable/disable config** for it. The
Consequences clause above ("wired through a config-gated path so serving can
be turned off without a deploy") is superseded by this amendment; the
requirement it served — being able to stop the vendor's spend without a
deploy — is met by the key binding itself, which is configuration, not code.

The adoption landed as ticket #168, inside the **existing Reviewer stage**
(domain pack), not as a new pipeline stage and not as a runner change:

- **Serving role.** `models.json` gains the `decision` role holding the pinned
  candidate the gate measured (`typesafe:jev-1.13.0`, `decide` capability,
  systemone protocol, input-only pricing). The bench-only
  `decision-candidates` role is unchanged and stays bench-only — a re-bench can
  add challengers without changing what serves. The serving role's
  `$comment` cites this ADR and the committed report
  (`packages/kajianq-domain/fixtures/decision-bench-results.json`).
- **Judgment shape.** One batched decision call per answer: every citation of
  the draft is one Noul question keyed by citation position (`c0`, `c1`, …),
  and the state carries each position's claim span plus the retrieved
  passage(s) that citation points at. Per-citation Noul ≥ 0.5 = supported.
  Every citation ≥ 0.5 → reviewed-clean, the paid LLM reviewer is skipped.
- **Order.** Deterministic citation validator first (free), pre-gate second,
  paid LLM reviewer last. A draft that fails the deterministic validator — or
  is a generator-emitted refusal — never spends on either.
- **Fail-open.** Any citation below threshold, any missing, malformed,
  non-finite **or out-of-range** answer (the seam documents Noul 0..1; `5` is
  finite and must read as unusable, never as support), any vendor failure, and
  any draft with no citation to judge escalate to the full LLM reviewer exactly
  as before. The pre-gate can therefore only ever _remove_ spend on an answer it
  affirmatively cleared; it never gates quality alone. The escalation reason is
  first-class persisted trace content (`decision` event: `below_threshold` /
  `no_items` / `malformed_answer` / `vendor_failure`), never a server log.
- **Traceability.** The call's spend lands as the review stage's `llm_call`
  event (model identity, tokens in/out, latency, computed cost), including the
  estimated cost of a failed attempt that reached the vendor; the verdict lands
  as the new typed `decision` event with the per-citation scores. The trace
  total stays the sum of recorded calls.
- **Cost posture.** The pre-gate replaces the escalation-tier reviewer call on
  the clean path with a batched input-priced call (~$0.0001 at 42 micro-USD per
  input MTok); the escalated path pays both, so the worst case is marginally
  more expensive than before — accepted, because escalation only happens on a
  doubted or unusable answer. The reviewer tier itself is the DeepSeek chain
  recorded in ADR-0044's 2026-09-21 amendment (same-vendor review accepted for
  the current key set); the "cross-vendor reviewer" phrasing in this ADR's
  Context is the 2026-09-19 state of the world and is not a current claim.
- **Vocabulary note.** The `decision` event's reason `no_items` is the generic
  engine wording (the decision seam is domain-agnostic); for the reviewer
  pre-gate it means the draft cited nothing, so there was nothing to clear.
- **Personal-data posture (thermo review A1).** The pre-gate's state _is_ the
  drafted answer's claim spans, so the `Decider` seam now carries what the
  `Provider` seam already had: `DecisionSpec.personalData` is a **required**
  field (ADR-0044 `PromptSpec` parity — a compile error to drop), the pre-gate
  sends `true`, and the register rule is enforced at the seam, not only at
  resolution — `resolveDecider` with `personalData: true` (the serving wiring)
  drops a candidate whose vendor forbids personal data and reports it in
  `ineligibleKeys`, and the systemone adapter fails such a spec **before the
  wire** (`bad_request`, no spend) if one is ever reached. The bench resolves
  without the flag, so its candidate set is unchanged. The vendor row's
  `personalDataAllowed: true` is itself **conditional on the processing
  agreement**: the Art. 30 record lists it as not yet on record (§10, thermo
  review C1), and binding `JEV_API_KEY` in production is gated on the owner
  recording it.
- **Evidence scope (thermo review A3).** The committed gate measured
  **isolated single-question calls** over `{claim, passage}` (the citation task,
  6/6); serving sends **one batched call** whose state is `{citations: […]}`,
  one Noul question per citation position. Positional pairing and judgment under
  sibling citations are therefore **extrapolated, not measured** — the batched
  variant is standing duty on the #167 gate fixture (the rerank task's
  positional keys are the only positional shape the gate did measure). Until it
  lands, the Golden Set `decision`-event escalation rate is the instrument that
  would show the serving shape misbehaving.
- **Golden Set evidence for this adoption (thermo review C2).** Four runs
  against `golden-set-v0` on the same store, citable in `eval_runs`: baseline
  `dc6518ef` and a second baseline sample `15b1a396` on unmodified `main`,
  control `c9fc8ee7` (pre-gate inactive), adoption `bd07033a`. They are n=20
  single samples: the pre-adoption baseline's own spread is 3→7 refusals (false
  1→5) and citation validity 0.550→0.400, and the adoption values (6 refusals,
  cv 0.400) sit inside it, with recall 0.975 confounding equally. The adoption
  is therefore justified on the **aggregate reading** — inside the pre-adoption
  band — not on a powered comparison, and that is the reading the ticket's
  AC #5 records. `gs-v0-015` (the known #142 retrieval gap) is the one run-C
  case where a pre-gate-cleared answer scored 0, and it is on the
  fixture-enrichment watchlist.
- **Trace rendering (thermo review C3).** The verdict is persisted trace content
  and API-visible today; the trace panel renders the decision model's identity
  generically, from `cost.modelId`, and **not** yet the outcome and per-citation
  items. Extending `ChatTraceFrame.technical` is follow-up ticket #221.
- **Adoption #2 (thermo review B3).** The generic half of the runner (call →
  `llm_call` → `decision` → fail-open classification) is to be extracted when
  the second adoption lands rather than copied; with a single adopter the
  interface would be a guess.

The gate evidence this adoption rests on is unchanged and remains `v0-draft`:
21/21 overall and per-language (ar/id/en) for 21 micro-USD. A perfect smoke
score is not a claim of infallibility — the fail-open design, not the score,
is what makes the adoption safe.
