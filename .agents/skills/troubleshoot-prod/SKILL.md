---
name: troubleshoot-prod
description: Diagnose a live fault on kajianq.ahaqqu.com — a 500, a hung endpoint, wrong or missing answers, "the site is broken". Probes the deployed API from the outside, reads each failure signature, and hands the operator the right evidence. Use when the production site errors and the cause is unknown.
disable-model-invocation: true
source: project
synced: 2026-11-13
---

# Troubleshoot prod — diagnose a live fault

Work outside-in: learn everything the public API can tell you before touching the
box, then escalate with evidence instead of guesses. The host facts (topology,
retention, permission model) live in [`docs/VPS-OPERATIONS.md`](../../../docs/VPS-OPERATIONS.md)
and [ahaqqu/vps docs/ACCESS.md](https://github.com/ahaqqu/vps/blob/main/docs/ACCESS.md) —
this skill is the workflow those facts serve.

## What you can and cannot reach

Two identities, two reach sets:

- **`kajianq-deploy`** (local key `~/.ssh/kajianq-deploy`) runs exactly the verbs
  the vps grant lists: `vps-deploy kajianq` (deploy, `--rollback`, and the four
  service verbs), `systemctl start kajianq-cron.service`, `nginx -t`,
  `certbot certificates`. **`journalctl` is not among them** — a log read needs
  the owner.
- **`ahaqqu`** (owner, interactive sudo) reads logs and the database, edits
  `/etc/kajianq/api.env`, and runs the helper's restart. `ssh ahaqqu@62.83.35.220`,
  then `sudo journalctl -u kajianq-api.service` (journald holds API logs 14 days /
  512M). Every log line carries a `correlationId`, and the nginx access log carries
  the same id — one id joins a request across proxy, API and trace.

`APP_ENV` on the box is `staging` by posture — one deployment, deliberately
labelled, so a health payload reading `"env":"staging"` is the box working as
recorded. It is not a misdeployed artifact; look elsewhere.

## The probe ladder

Run the rungs in order. Each rung either ends the diagnosis or names the next
rung. Everything runs from any machine with `curl`; nothing here logs into the
box. Stop spending as soon as a rung answers the question.

1. **Health.** `GET /v1/health`. A 200 says the process, listener and nginx path
   are alive — keep going. A timeout or 5xx is a downed service or proxy: go
   straight to escalation, the ladder below assumes a serving process.
2. **Date the deployed code.** `GET /openapi.json` and match a schema's wording
   against git history — pick a contract string that changed recently and find
   the commit that introduced it (`git log -S '<substring>' -- packages/contracts/`).
   The served document is built from the deployed tree, so a matched string dates
   the artifact to at least that commit. Done when you know the deployed window.
3. **Mint an anonymous session.** `POST /v1/auth/anonymous` with `{}`. A token
   proves the store's write path and auth wiring work. A 5xx here moves the
   suspicion to the database or the wiring, below the vendor layer entirely.
4. **Prove the validator.** `POST /v1/chat` with a malformed body → expect
   `400 invalid_request`; without a token → `401 unauthorized`. These are the
   contract layers answering, not the pipeline.
5. **Prove the store read.** `POST /v1/chat` with the token and
   `"sessionId":"00000000-0000-4000-8000-000000000000"` → expect `404` in well
   under a second. Done when the session lookup returned.
6. **Split the pipeline.** Send a message with no letter and no digit (an
   emoji-only string): the router's pre-gate marks it content-free and the run
   answers with the canned decline — session create, user-message insert, trace
   persistence and the whole SSE stream, with **zero vendor calls**. A `200`
   here clears everything the pipeline does before and after the model stages.
7. **Send a real question** (synthetic text, never a real user's) and read the
   signature: a `500 {"error":"internal"}` arriving at the ~2–4s mark, with the
   decline path of step 6 healthy, names a **vendor stage** as the fault. No
   `meta` frame on the wire means the run failed before the stream began.

Timing is a signature too: ~0.7s is the store/decline round trip; ~2–4s is one
failed vendor round trip (retries included); minutes or a hang is a stuck
stream, and the proxy's read timeout ends it.

## Audit the vendors

The serving role chains are declared in
`packages/infra/src/providers/models.json` — read them there, never from memory.
Then probe each serving vendor **directly** with a one-token call using the key
the owner's environment carries: the HTTP status is the diagnosis. One tiny call
per vendor costs far less than one chat answer.

| Vendor response                      | Meaning                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `401` / authentication error         | the key is invalid or was rotated; every call fails    |
| `402` / credits or billing exhausted | the prepaid balance is gone; top-up is operator action |
| `429`                                | quota or rate exhaustion; may clear on its own         |
| `400`/`404` naming the model id      | the model was retired or renamed; config change        |

Two config facts shape the read:

- The **embedder** role is a single candidate with no fallback — the corpus
  embedding space is locked to it — so an embedder failure alone 500s every real
  question while content-free declines still answer. A dead embedder explains a
  "chat is broken" report faster than any other single vendor.
- `PROVIDER_PROFILE` may offer an alternate serving profile, but check it
  actually replaces the broken role before recommending the switch — a profile
  that moves the chat roles while the embedder stays put changes nothing for a
  retrieval-path failure.

## Escalate with evidence

Hand the owner the commands, not the conclusion:

- **Logs:** `sudo journalctl -u kajianq-api.service --since '<window>'` and grep
  the `correlationId` from a probe. The API logs the underlying error on
  `request.unhandled`; a vendor failure's status and message are in that line.
- **A failed run's trace:** the route persists a failed run's trace before
  answering 500, so the row exists; reading it needs `psql` on the box or an
  admin surface.
- **Fix paths:** key rotation and credit top-ups end in `/etc/kajianq/api.env`
  (owner-only edit) followed by `sudo /usr/local/sbin/vps-deploy kajianq
  restart`; a bad artifact rolls back with `vps-deploy kajianq --rollback`; a
  host-config change is a PR to ahaqqu/vps, never a hand edit. A code fix is a
  normal PR through this repository's workflow.

## Guardrails

- **Probe cost:** one tiny vendor call per vendor per diagnosis; probes run
  synthetic text, never a real user's question, and a real question goes through
  at most once.
- **Personal data:** questions are personal data — a question text pasted into a
  ticket, log excerpt or report must be synthetic.
- **Rate limits:** the chat route is rate-limited like any client; a `429` on a
  probe is the limiter doing its job, not the fault.

## Local repro

`bun run apps/api/src/boot.ts` serves `127.0.0.1:8787`, configured from the
environment (`DATABASE_URL`, the vendor keys, `PROVIDER_PROFILE`). Before
blaming code for a local wiring failure, verify the environment actually
provides what the boot log says is missing: a stale or empty `DATABASE_URL`
reproduces as `chat_not_configured` or a store that hangs, which reads like a
code fault and is not one.
