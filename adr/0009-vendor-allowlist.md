# Vendor allowlist: Gemini, Kimi, DeepSeek, Qwen only

All LLM and embedding providers are restricted by user policy to Google Gemini, Moonshot Kimi, DeepSeek, and Alibaba Qwen — Anthropic, OpenAI, and xAI are excluded (2026-08). Consequences: the generator defaults to Qwen3.7-Max, the cross-vendor reviewer to Gemini 3.1 Pro, the cheap tier to Gemini 3 Flash (free tier) with DeepSeek V4-Flash fallback, ingestion translation to Qwen3 Max, and embeddings to `gemini-embedding-001` (replacing the spec's Cohere choice; must be validated on our Arabic+Indonesian corpus by the benchmark harness). This amends the template's "never add paid services to the critical path" guardrail: paid LLM/embedding APIs ARE accepted in the critical path because no free tier exists at generator quality — but price must be weighed in every model decision and cost is traced per query. Tie-break rule: when Gemini and Qwen are near-equal in capability, prefer Qwen. All choices remain swappable via the Provider interface; the benchmark harness re-validates candidates.

## Amendment (2026-09-12): generator and reviewer cost posture — DeepSeek V4-Flash + Gemini 3 Flash Preview

**Decision.** The `generator` role's chain head moves to `deepseek:deepseek-v4-flash`
($0.14/$0.28 per MTok). Its `qwen:qwen3.7-max` tail was **removed the same day**
(owner decision, 2026-09-12): DashScope is not provisioned and will not be, and
`resolveRole` silently filters candidates whose `apiKeyEnv` is unset — so the tail
advertised a failover that could never be wired. The generator is therefore a
single candidate and an accepted single point of failure (a failure costs one
≤$1 smoke re-run, not data). The `reviewer` role moves to
`gemini:gemini-3-flash-preview` ($0.50/$3). Both changes are config-only
(`packages/infra/src/providers/models.json`); no code path branches on vendor or
model identity, and every call still records its own `CostRecord` with the model
it actually ran on.

**Why.** Two facts, one of which this ticket created:

1. **#10 invalidated the cost model's reviewer assumption.** SPECS §5 priced the
   reviewer as a "10% sample" (~$1/1K queries). The chat path now runs the
   cross-vendor reviewer on **every** answer as a mandatory gate, so a
   `gemini-3.1-pro-preview` reviewer ($2/$12) is billed on 100% of traffic and
   becomes the largest line in the model (~$24/1K queries) — larger than the
   generator it was protecting. The cost model must describe the system that
   exists, not the sampling design that was superseded.
2. **The DashScope (Qwen) key is absent in this environment** — already recorded
   in ADR-0036 when the #9 gate ran, and it is what made the live staging smoke
   unable to produce an answer at all.

**Why this does not weaken the trust invariant.** The #10 invariant is enforced by
the deterministic grammar-driven citation validator (which refuses first and does
not consult any model) plus the reviewer gate. Vendor _separation_ — DeepSeek
generator, Gemini reviewer — is preserved, which is what makes the review
independent; model _tier_ is a cost/capability dial, and the reviewer's verdict is
still a hard gate rather than a sample.

**Live-API verification (2026-09-12, before the staging smoke).** The chosen ids
were exercised against the vendors' real endpoints, not assumed:

- `deepseek-v4-flash` is accepted by `https://api.deepseek.com/v1/chat/completions`
  and resolves to the vendor's canonical `deepseek-flash` (the response's `model`
  field); `/v1/models` lists `deepseek-flash` and `deepseek-v4-pro`, and a bogus id
  is rejected with "The supported API model names are …". The catalog id therefore
  works as written — the trace records the configured id while the vendor echoes
  its canonical name, which is intended (config identity, not vendor spelling).
- It is a **reasoning** model: a short `max_tokens` is consumed by
  `reasoning_content` and returns an empty `content` (verified: `max_tokens: 32`
  → empty content, `finish_reason: length`). The chat path sets no `max_tokens`
  (`buildChatRequest` forwards only `spec.options`), so answers are unaffected —
  but any future per-call cap must leave room for reasoning tokens, and reasoning
  spend is billed as output at the listed out-price.
- `gemini-3-flash-preview` and `gemini-embedding-001` were exercised through the
  role drill (`bun run provider:smoke`): `cheap`, `reviewer`, `reviewer-live`, and
  `embedder` all answer on this account.

**Consequences / standing duty.** The cheaper pair is a hypothesis, not a proven
posture: `bun run eval:run` (Golden Set, free-tier capped) must show it neither
lets ungrounded citations through nor inflates refusals, and the PR-time
`bun run eval:smoke` now runs against live staging on every Staging deploy. A
regression in either direction reverts the chain head — one line per role. The
reviewer's promotion path stays recorded in SPECS §3.4's Alt column
(`gemini-3.1-pro-preview`); restoring a generator fallback means **re-adding**
`qwen3.7-max` to the chain _and_ binding `DASHSCOPE_API_KEY` — not reordering a
list that no longer contains it.

**Alternatives considered.**

- **Buy a DashScope key, keep Qwen3.7-Max + Gemini 3.1 Pro.** Rejected for now as
  the default: $2.50/$7.50 generator and $2/$12 reviewer on every answer is ~15×
  the chosen pair, and the owner's stated posture is best-value rather than
  quality-at-any-price. Remains a future promotion path only: the tail was removed
  from the chain, so it must be re-added once a key is bound.
- **Gemini generator + Gemini reviewer.** Rejected outright: it is same-vendor
  self-review, which is exactly the property ADR-0015's cross-vendor check exists
  to avoid — it would leave the reviewer gate formally intact and substantively
  hollow.
- **`kimi-k2.6` as reviewer ($0.55/$2.20).** Kept as the documented challenger;
  not chosen because it needs a third vendor key and its review quality is
  unmeasured, while flash-preview is already the catalogued `reviewer-live` model.
- **A staging-only model override.** Rejected as scope: there is no per-stage
  model seam today, and inventing one to avoid this decision would leave the
  product default unexamined while adding a new configuration surface.
