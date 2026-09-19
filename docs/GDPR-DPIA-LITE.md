# DPIA-lite note — why a formal Art. 35 DPIA is not triggered at this scale

Internal note accompanying the Art. 30 record
([`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md)). Issue: #178
(GDPR-B). Scope: the netcup VPS deployment decided in
[`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md).

This is a **DPIA-lite** — a recorded screening assessment under Art. 35(1), not
a full impact assessment. It states (a) why a formal DPIA is not required at the
present scale, (b) the one honest complication — chat content can reveal Art. 9
religious convictions — and (c) the mitigations that keep that risk proportionate.
It is written so the owner can revisit it at public beta rather than re-derive it.

## 1. The Art. 35(1) screening question

Art. 35(1) requires a DPIA where a type of processing is **likely to result in a
high risk** to the rights and freedoms of natural persons, taking into account
the nature, scope, context, and purposes of the processing. The three
Art. 35(3) triggers are the concrete, non-exhaustive high-risk cases:

| Art. 35(3) trigger                                                                                             | Applies here? | Reasoning                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) systematic and extensive **evaluation of personal aspects**, incl. profiling, on which decisions are based | **No**        | There is no profiling, no scoring, and no automated decision-making with legal or similarly significant effects. The system routes a question to retrieval stages and generates a cited answer; it forms no judgement about the person.       |
| (b) **large-scale** processing of **Art. 9 special-category** or Art. 10 criminal data                         | **No**        | Art. 9 content is incidental and voluntary, not collected as a category (see §2). The scale is a pre-public-beta service, not "large scale" in the Art. 35(3) sense.                                                                          |
| (c) **systematic monitoring** of a publicly accessible area on a large scale                                   | **No**        | KajianQ does not monitor a publicly accessible area. The 14-day access log exists for abuse investigation and incident triage, is deliberately short so it cannot become a system of record, and no behavioural profiling is derived from it. |

Data subject categories, volume, and the absence of vulnerable-subject targeting
also point away from a high-risk finding: data subjects are anonymous visitors
identified only by a random pseudonymous id, there is no account, no email, no
payment data, no location data, and no children-specific feature.

**Conclusion: a formal DPIA is not triggered at this scale, on the Art. 35(3)
analysis above.** This is a screening outcome, not a permanent exemption — see
§5 for the revisit triggers.

## 2. The Art. 9 complication, stated honestly

The screening above must not hide the real concern.

**Chat content can reveal religious convictions.** A question about a fiqh
ruling, an aqidah point, or a madzhab comparison discloses something about the
asker's belief or practice. With the persisted Trace (ADR-0007), the question is
stored alongside the retrieved passages and the model metadata, so the Art. 9
dimension survives even though the session is anonymous.

Two things follow, and both are already the product's posture rather than
aspirations:

1. **The convictions are in the text, not in the identifier.** Anonymity removes
   the direct link to a named person; it does not remove the sensitivity of the
   content. This note treats the content as the sensitive asset it is.
2. **The processing is incidental and voluntary.** KajianQ never asks for
   religious affiliation, belief, health, or any other Art. 9 attribute. There is
   no onboarding, no profile, and no field that collects one. Disclosure is made
   by the data subject in the course of asking their own question.

The processing is therefore Art. 9-adjacent in content but not a systematic
large-scale collection of special-category data — which is why it informs the
risk analysis without triggering Art. 35(3)(b). Whether an explicit Art. 9(2)
condition must be surfaced in the product at public beta is recorded as an open
item in the Art. 30 record §10 for the owner's legal review; it is not asserted
as settled here.

## 3. Art. 9 mitigations

| Mitigation                                    | What it does here                                                                                                                                                                                                      | Evidence                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous by design** (ADR-0017)            | Pseudonymous UUIDs; no accounts, no email, no identity provider; there is nothing to correlate a conviction to beyond the session itself                                                                               | `users`/`sessions` schema (`packages/infra/migrations/0001_init.sql`); ADR-0017                                                                                                                |
| **Local-first session token**                 | The plaintext Bearer token is returned to the client once and never stored server-side — only its SHA-256 hash is persisted; the client keeps it in `localStorage`, not a cookie                                       | `sessions.token_hash`; `apps/web/src/lib/chat-store.ts`                                                                                                                                        |
| **No profiling, no automated decisions**      | The pipeline routes and generates; it does not score, segment, or decide about the person. The cross-vendor reviewer judges the _answer's_ faithfulness, not the person                                                | `packages/kajianq-domain/src/chat-*.ts` (pipeline stages), ADR-0021                                                                                                                            |
| **No free-tier routing of personal data**     | Personal data never routes through a vendor free tier; `personalDataAllowed` gates the candidate chain for any call declaring `personalData`                                                                           | `packages/infra/src/providers/models.json`, `FallbackProvider` in `provider-factory.ts` — **the seam works; serving call sites do not set the flag yet, an open precondition tracked by #181** |
| **Erasure cascade** (Art. 17)                 | One authenticated call deletes the user and their whole subtree — sessions, chat sessions/messages, Traces, feedback                                                                                                   | `DELETE /v1/auth/me` → `deleteUserCascade`                                                                                                                                                     |
| **Deliberate log retention**                  | Access logs are 14 days, so the IP-bearing log cannot become the de-facto record of who asked what; structured API logs carry a correlation id and no IP                                                               | ADR-0043 decision 4; GDPR-D (#180) implements it                                                                                                                                               |
| **Storage limitation**                        | 30 days of inactivity for anonymous sessions and their whole subtree, reclaimed by a nightly cron; no separate age-based chat deletion, and the record says so rather than implying a shorter window                   | `cleanupExpiredSessions`, `crons: ["17 3 * * *"]`; ADR-0043 decision 4                                                                                                                         |
| **Encrypted backups with re-applied erasure** | Backups are encrypted at rest with an off-repo key, 30-day rolling, and never used to answer a subject request; after a restore the reclamation/erasure path is re-run so a restored row cannot resurrect deleted data | ADR-0043 decision 4; GDPR-D (#180)                                                                                                                                                             |
| **EU/Germany residency**                      | Chat content and Traces land on a netcup GmbH VPS in Germany under a DPA (Art. 28(3)), not spread across vendors' free plans                                                                                           | ADR-0043; GDPR-E (#181) executes the move                                                                                                                                                      |

## 4. Residual risk

| Residual risk                                                                                       | Assessment                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Art. 9 content is present in `chat_messages`/`answer_traces` for up to 30 days of inactivity        | Accepted. Bounded window, erasure on demand, encrypted backups, EU residency. The alternative — deleting a returning user's transcript — was a product decision recorded in ADR-0043 decision 4, not an oversight. |
| A chat question can ride the free-tier Gemini head today (the `PromptSpec.personalData` gap)        | **Open, and the largest single residual.** ADR-0043 records it as a precondition of serving public traffic from the VPS; #181 must not serve public traffic while this holds.                                      |
| Transitional free-tier rows (Cloudflare, Neon) process personal data while the migration is pending | Recorded residual risk in ADR-0043's register; retirement is #181. Mitigated by the register rule applying to the target state and by the migration scope.                                                         |
| Snapshot archives carry personal data on the ObjectStore prefix                                     | Flagged in ADR-0043 decision 5; encrypted before personal data lands on the VPS; superseded archives deleted 30 days after a successor verifies.                                                                   |
| No dedicated Art. 15/20 endpoint (access, portability)                                              | Handled manually by the operator today; extends with real user identity (ADR-0043 revisit trigger).                                                                                                                |

## 5. Revisit triggers

Re-run this screening — and expect a full DPIA — if any of these happens:

- **Real user identity** is adopted (the ADR-0017 revisit trigger): accounts,
  cross-device history, or paid tiers make the processing systematic and
  attributable, and Art. 15/17/20 duties extend beyond cascade erasure.
- The service reaches a **scale** where Art. 35(3)(b) "large-scale" is
  arguable — a threshold the owner should set with actual usage numbers, not
  guess here.
- Any **profiling, personalisation, or automated decision-making** is introduced.
- New **Art. 9-adjacent features** (e.g. health-adjacent fiqh intake, location
  data, or a user profile) are added.
- A new **processor or hosting region** joins the register, especially outside
  the EU.
- A **data breach** involving chat content or the IP-bearing access log.

## See also

- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) — the Art. 30 record this note accompanies
- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — hosting, register, retention, and the `personalData` gap
- [`adr/0017-anonymous-sessions-over-hosted-identity.md`](../adr/0017-anonymous-sessions-over-hosted-identity.md) — the anonymous-session model
- [`adr/0007-user-facing-trace-and-feedback.md`](../adr/0007-user-facing-trace-and-feedback.md) — the persisted Trace and cascade erasure
