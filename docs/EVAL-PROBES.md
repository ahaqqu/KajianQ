# Independent eval probes

`packages/kajianq-domain/fixtures/independent-probes-v1.json` is a small,
separate fixture for the five questions the manual independent check asked. It
is **not** the Golden Set and is never counted as one: it has no
`questions`/`status` fields, no expected source types, no refusal rows, and the
runner applies none of the Golden Set's coverage floors. There is no ledger
write and no CI job.

The suite exists so a human can re-ask the same five canonical questions after a
change and read a deterministic verdict — expected citations grounded, plus a
short content check — alongside the answer's size and citation count.

## Probes

| Probe id             | Topic                              | Language | Expected citation(s)     |
| -------------------- | ---------------------------------- | -------- | ------------------------ |
| `probe-4-103`        | Prayer at fixed times              | `id`     | `QS. 4:103`              |
| `probe-bukhari-1`    | Intention in deeds                 | `id`     | `HR. Bukhari no. 1`      |
| `probe-2-275-278`    | Prohibition of riba and leaving it | `id`     | `QS. 2:275`, `QS. 2:278` |
| `probe-bukhari-6094` | Truthfulness and lying             | `id`     | `HR. Bukhari no. 6094`   |
| `probe-17-23-24`     | Honouring parents                  | `id`     | `QS. 17:23`, `QS. 17:24` |

Each probe also carries `expectedContent`: a list of `{ label, anyOf }` checks.
Every check must match; a check matches when any of its `anyOf` terms appears as
a whole word or phrase in the answer, after a generic Unicode fold (case,
combining marks, and punctuation/whitespace are normalized). The check names
concept labels (`prayer`, `fixed times`, `intention`, ...), not answer prose, so
a re-worded but correct answer can still pass.

## Pass rule

A probe passes when **every** expected citation is grounded in the answer and
**every** content check matches. Citations are read by the same deterministic
reader the Golden Set uses for citation validity: the server's citations frame
when the chat client returns one (an empty frame is authoritative), otherwise
the answer text through the domain's citation grammar. A transport failure is
reported as that probe's error, not as a missing citation, and the other probes
still run. The run exits non-zero when any probe fails.

Answer length and citation count are the same descriptive derivation the eval
report aggregates (Unicode code points; distinct citation labels), so the two
surfaces cannot disagree about what an answer carried.

## Running it

The live run needs the staging chat target and an anonymous Bearer token; it
needs no database, because it writes no ledger row.

```bash
EVAL_API_BASE_URL=https://<staging-host> \
EVAL_API_TOKEN=<anonymous token> \
bun run eval:probes
```

| Env var                   | Required | Meaning                                                 |
| ------------------------- | -------- | ------------------------------------------------------- |
| `EVAL_API_BASE_URL`       | yes      | The `/v1/chat` origin (http(s)).                        |
| `EVAL_API_TOKEN`          | yes      | An anonymous Bearer token minted by the API.            |
| `EVAL_PROBE_FIXTURE_PATH` | no       | Fixture override; defaults to the domain fixture above. |

**Cost expectation:** the runner makes exactly one chat answer per probe — five
with the default fixture — and no other call of its own. The spend is therefore
the pipeline cost of five answers (retrieval, generation, and any reviewer
calls each answer triggers), comparable to one default five-question
`eval:smoke` sample. It is bounded by the probe count and there is no ledger,
replay, or follow-up spend. It is **not** wired into CI; run it manually when a
change could affect these five answers.

The output names each probe with its verdict, answer length, citation count, and
the missed citations/content checks, then a `passed`/`failed` tally.

## Offline tests

The fixture parse, content fold, citation/content scoring, report formatting and
exit policy are deterministic and model-free; these tests make no network call:

```bash
bunx vp test run \
  packages/eval/src/independent-probes.test.ts \
  packages/eval/src/answer-metrics.test.ts \
  packages/kajianq-domain/src/independent-probes.test.ts
```

The engine test loads the real fixture and proves every probe is scorable from
its own expectations; the domain test pins the five rows' ids, languages,
expected citations and content-check labels.
