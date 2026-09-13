# ADR-0040: Structured citation payload and session rehydration — the trace is the source of truth

## Status

Accepted (2026-09-13). Implements issue #11 (P2 chat UI). Extends the wire
contract of ADR-0034 (SSE `meta → delta → done` gains one `citations` frame)
and ADR-0017 (the anonymous session id persists client-side so a reload
rehydrates the transcript). Does not change ADR-0021 (traces are assembled by
the pipeline runner) or the citation gate's refusal semantics.

## Context

- Issue #10 put `/v1/chat` live: answers stream as SSE, and citations, the
  dhaif warning (`[Peringatan] …`), and the ulama disclaimer exist **only as
  inline text**. The UI would have to parse the answer text to attach
  citation affordances — i.e. re-implement the citation grammar client-side.
- The product's #1 stated risk is fabricated religious content. The
  deterministic citation gate (ADR-0034) already refuses answers citing
  anything outside the retrieved chunks. A client-side grammar parser would
  silently re-open that hole: any parsing drift turns a fabricated span into
  a chip, and the failure mode is invisible (a confident UI over an
  unverified citation).
- The per-answer data needed for a citation UI — **which** chunks were
  retrieved, and (since thermo-review B4) which citation labels the answer
  actually grounded — is already persisted, per answer, in `answer_traces`
  (ADR-0007). The user-visible data structures must come from persisted trace
  records (traceability guardrail), not from ad-hoc reconstruction.
- A reload must restore the conversation. The session id + Bearer token are
  anonymous-session state (ADR-0017 — low stakes by design), so they persist
  in `localStorage`; the transcript itself is server state and must be
  re-readable, including its citation affordances, for every past message.

## Decision

1. **The server derives a structured citation payload from the persisted
   answer trace; the client never parses answer text for citations.**
   - `POST /v1/chat` emits one SSE `citations` frame after the deltas and
     before `done`: `{ messageId, citations[], refusal, dhaifWarning }`.
   - The derivation is an **intersection**: emitted citations = the answer's
     inline citation spans (located with the citation gate's own grammar and
     normalization, `@app/kajianq-domain` chat-citation-validator) that a
     chunk referenced by the trace's `retrieval` event **grounds**. A span
     matching no trace chunk cannot appear in the payload — the same
     invariant the gate enforces upstream, now enforced again at the
     display boundary. Proven in both directions by table tests plus a
     fast-check property (`apps/api/src/lib/chat-citations.test.ts`).
   - Display data (Arabic original, translation layer, grade, parent source)
     is joined by the trace's chunk ids via a new `RagStore`
     `getDocChildrenByIds` read — the same store rows retrieval served, the
     same embedding-stripping contract as `similaritySearch`.
   - A refused answer emits `refusal: true` and an empty citation list.
   - `GET /v1/chat/sessions/:id/messages` rehydrates the full transcript and
     derives each assistant message's payload from **its persisted trace**
     (read via the `chat_messages.answer_trace_id` FK through a new
     `getAnswerTraceById` seam read — `answer_traces.message_id` carries the
     route's answer message id, not the chat row's id). One store read
     resolves the display data for the whole transcript. The live frame and
     the rehydrated payload are the same derivation, so a past answer can
     never show a citation its trace does not ground.
2. **The client renders the frame, never the grammar.** Citation chips are
   located in the answer text by exact-match of frame labels only; a label
   absent from the text renders nothing, and a bracketed span absent from
   the frame stays plain text. The dhaif warning card shows the answer's own
   warning line (peeled by the rule's stable marker prefix) and is driven by
   the frame's `dhaifWarning` flag when a rehydrated text lacks the line;
   the ulama disclaimer renders as a distinct footer, peeled the same way.
3. **Reload = full rehydration.** The session id + token persist in
   `localStorage` (ADR-0017 anonymous sessions — erasure stays server-side
   via `DELETE /v1/auth/me`); on load the UI restores the transcript from the
   rehydration endpoint. "New session" is an explicit button that clears the
   local session id; follow-ups ride the stored session id. A 401
   re-bootstraps the anonymous token silently and retries once; a reclaimed
   session (404) starts clean.
4. **Streaming stays UI-scoped (no API streaming change).** The wire keeps
   ADR-0034's reviewer-gated replay (`meta → delta(s) → citations → done`);
   the deltas sequence is unchanged. The consumer is streaming-native (it
   appends deltas whether there are one or many) and the UI shows an honest
   staged waiting state ("Mengambil konteks…" → "Memeriksa sitasi…" →
   "Menyusun jawaban…") describing the machinery that is actually running.
   E2E runs on mocked SSE fixtures — zero LLM spend in CI; the live path
   stays covered by `eval:smoke`.

## Alternatives rejected

- **Client-side citation parsing** (chip-ify bracketed spans with a web-side
  grammar): re-implements the gate's grammar in a second language with no
  shared tests; drift fabricates citations silently. Rejected — this is the
  trust failure the whole ticket exists to avoid.
- **GET-only on tap** (resolve a citation's passage data when the user taps):
  keeps payload size small but makes the UI affordance depend on a per-tap
  endpoint (latency, new failure mode mid-reading) and still needs a
  client-side decision of _which_ spans are citations. Rejected.
- **Persisting the citation payload on the chat message at answer time**
  (denormalized JSONB on `chat_messages`): duplicates a derivable structure,
  creates a second source of truth that can drift from the trace, and still
  needs the chunk join at write time. The trace is already the durable,
  user-visible record. Rejected.
- **Extending the trace's chunk refs to carry display text** (self-contained
  traces): would change the engine's trace projection and duplicate corpus
  text (Arabic + translation) into every trace row for data that lives one
  store read away. Rejected (the by-id read keeps traces lean).

## Consequences

- New shared contracts in `@app/contracts` (`ChatCitationSchema`,
  `ChatCitationsFrameSchema`, `ChatSessionMessagesSchema`) — engine package,
  domain values travel as plain strings.
- New `RagStore` reads: `getDocChildrenByIds` and `getAnswerTraceById`
  (Neon adapter + memory test store). No engine logic changed; the pipeline
  runner, stages, and refusal gate are untouched.
- The eval harness's SSE client ignores the new `citations` frame (it reads
  `meta`/`delta` only), so ledger keying is unchanged.
- A chunk row deleted after an answer was persisted simply loses its chip
  (invariant by omission); a lost trace or an unreadable one degrades to a
  plain-text transcript, never to invented citations.
- The rehydration transcript is capped (200 messages — a session is an
  anonymous conversation, not an archive). The cap is VISIBLE, not silent:
  `ChatSessionMessages.truncated` (detected by reading one row past the cap)
  tells the client it is seeing the newest tail, and the UI says older
  messages are not shown (thermo-review A4).
- The UI's `machineTranslated` flag tracks the translation layer's PRESENCE,
  matching the assembler's `MACHINE_TRANSLATION_LABEL` — a coupling enforced
  by test, not by data. A human-checked translation layer in the corpus must
  not land by data mutation alone: it needs a per-chunk provenance field
  consumed by the derivation (and an ADR) before the flag's meaning may
  change (thermo-review A3).
- The one trust-sensitive review point: `deriveCitationsFrame` — the emitted
  set must remain exactly the cited-and-grounded intersection.
