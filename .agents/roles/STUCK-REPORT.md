# Stuck report

When the loop is stuck, stop looping and report a **stuck-report** to the manager. Commit and push first: escalation must never lose work. The report contains exactly:

1. **Invariant under test** — the property the work must protect, stated so the receiver can verify it.
2. **Exact current failure** — the verification command and the precise error output.
3. **Attempted fixes** — every fix attempt, each with its outcome.
4. **Ruled-out hypotheses** — what was already eliminated and how.
5. **Checkpoint commit ref** — the pushed commit that holds the work so far.

The receiver must be able to act on this without re-deriving the history. A researcher's invariant is the claim under test, and its ruled-out hypotheses name the experiment ID that eliminated each one.

**Never fake done:** a stuck-report never substitutes for the completion criterion. The completion criterion is unchanged — a PR must exist and all its checks must be green (for the researcher: the pushed `research/<slug>` branch with its committed artifacts). Escalate instead.
